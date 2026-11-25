#!/usr/bin/env node
/**
 * Job lifecycle CLI for ai-video-editor.
 *
 * Usage:
 *   npm run edit -- --input workspace/inbox/<job> --preset tutorial-id
 *   npm run edit -- --input a.mp4 b.mp4 --job my-edit --resume
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FilmCraftClient } from "../../../services/editing-orchestrator/src/filmcraft/client.mjs";
import { TimelineBuilder } from "../../../services/editing-orchestrator/src/timeline/build.mjs";
import { compilePlan } from "../../../services/editing-orchestrator/src/plan/compile.mjs";
import { proposePlan } from "../../../services/editing-orchestrator/src/plan/propose.mjs";
import { validatePlan } from "../../../services/editing-orchestrator/src/plan/validate.mjs";
import { formatSrt } from "../../../services/editing-orchestrator/src/subtitles/srt.mjs";
import { computeClipGains } from "../../../services/editing-orchestrator/src/audio/loudness.mjs";
import { qcExport, verifySourceIntegrity } from "../../../services/editing-orchestrator/src/qc/check.mjs";
import { buildReport, writeReport } from "../../../services/editing-orchestrator/src/report/write.mjs";

const exec = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MEDIA_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".aac"]);

function parseArgs(argv) {
  const opts = {
    inputs: [],
    preset: "tutorial-id",
    job: null,
    planPath: null,
    resume: false,
    noExport: false,
    burnCaptions: null,
    timelineCaptions: null,
    bridge: process.env.FILMCRAFT_BRIDGE ?? null,
    controlToken: process.env.FILMCRAFT_CONTROL_TOKEN ?? null,
    cutKinds: null,
    model: "base",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "-i") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        opts.inputs.push(argv[++i]);
      }
    } else if (a === "--preset") {
      opts.preset = argv[++i];
    } else if (a === "--job") {
      opts.job = argv[++i];
    } else if (a === "--plan") {
      opts.planPath = argv[++i];
    } else if (a === "--model") {
      opts.model = argv[++i];
    } else if (a === "--resume") {
      opts.resume = true;
    } else if (a === "--no-export") {
      opts.noExport = true;
    } else if (a === "--burn-captions") {
      opts.burnCaptions = true;
    } else if (a === "--no-burn-captions") {
      opts.burnCaptions = false;
    } else if (a === "--timeline-captions") {
      opts.timelineCaptions = true;
    } else if (a === "--no-timeline-captions") {
      opts.timelineCaptions = false;
    } else if (a === "--bridge") {
      const next = argv[i + 1];
      opts.bridge = next && !next.startsWith("-") ? argv[++i] : "127.0.0.1:7991";
    } else if (a === "--control-token") {
      opts.controlToken = argv[++i];
    } else if (a === "--cut-kinds") {
      opts.cutKinds = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

async function resolveInputFiles(inputs) {
  const files = [];
  for (const raw of inputs) {
    const abs = resolve(raw);
    const st = await stat(abs);
    if (st.isDirectory()) {
      const entries = (await readdir(abs)).sort();
      for (const name of entries) {
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
        if (MEDIA_EXTS.has(ext)) {
          files.push(join(abs, name));
        }
      }
    } else {
      files.push(abs);
    }
  }
  if (files.length === 0) {
    throw new Error("No media files found in --input");
  }
  return files;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function saveJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveExportPreset(client, presetConfig) {
  const query = presetConfig?.presetQuery ?? { format: "h264", width: 1920, height: 1080 };
  const presets = await client.exportPresets();
  const list = Array.isArray(presets) ? presets : presets?.presets ?? [];
  const exact = list.find(
    (p) =>
      typeof p.name === "string" &&
      p.name.includes("1080p") &&
      (p.format === query.format || p.name.toLowerCase().includes("hd"))
  );
  if (exact) return exact.name;
  const fallback = list.find((p) => typeof p.name === "string" && p.name.includes("1080p"));
  if (!fallback) {
    throw new Error("No 1080p export preset found via export.presets.list");
  }
  return fallback.name;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.inputs.length === 0) {
    console.log(
      "Usage: npm run edit -- --input <dir|files...> [--preset tutorial-id] [--job <id>] [--plan <file>] [--bridge [host:port]] [--resume] [--no-export] [--burn-captions|--no-burn-captions]"
    );
    process.exit(opts.help ? 0 : 1);
  }

  const files = await resolveInputFiles(opts.inputs);
  const jobId =
    opts.job ??
    basename(resolve(opts.inputs[0])).replace(/[^a-zA-Z0-9_-]/g, "-");
  const jobDir = join(ROOT, "workspace", "projects", jobId);
  const logDir = join(jobDir, "logs");
  await mkdir(logDir, { recursive: true });
  console.log(`Job '${jobId}' -> output directory: ${jobDir}`);

  const statePath = join(jobDir, "job-state.json");
  const state =
    opts.resume && (await exists(statePath))
      ? await loadJson(statePath)
      : { jobId, completed: {}, updatedAt: null };

  const markDone = async (phase) => {
    state.completed[phase] = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await saveJson(statePath, state);
  };

  const presetPath = join(ROOT, "presets", `${opts.preset}.json`);
  const preset = await loadJson(presetPath);
  if (opts.burnCaptions !== null) {
    preset.subtitles = { ...(preset.subtitles ?? {}), burnIn: opts.burnCaptions };
  }

  // 1. Analyse (Python vidintel)
  const mediaPath = join(jobDir, "media.json");
  const analysisPath = join(jobDir, "analysis.json");
  if (!opts.resume || !state.completed.analyse || !(await exists(mediaPath))) {
    console.log(`[1/6] Analysing ${files.length} source(s) -> ${jobDir}`);
    const py = join(ROOT, ".venv", "bin", "python");
    await exec(
      py,
      [
        "-m",
        "vidintel",
        "pipeline",
        ...files,
        "--out-dir",
        jobDir,
        "--job",
        jobId,
        "--model-dir",
        join(ROOT, "workspace", "models"),
        "--model",
        opts.model,
        "--language",
        preset.language ?? "id",
      ],
      { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }
    );
    await markDone("analyse");
  } else {
    console.log("[1/6] Analyse (resumed)");
  }

  const media = await loadJson(mediaPath);
  const analysis = await loadJson(analysisPath);
  const transcriptsBySource = {};
  for (const s of media.sources) {
    const tp = join(jobDir, `transcript.${s.index}.json`);
    if (await exists(tp)) {
      transcriptsBySource[s.index] = await loadJson(tp);
    }
  }

  // 2. Plan
  const planPath = join(jobDir, "editing-plan.json");
  let plan;
  if (opts.planPath) {
    plan = await loadJson(resolve(opts.planPath));
    await saveJson(planPath, plan);
    await markDone("plan");
  } else if (!opts.resume || !state.completed.plan || !(await exists(planPath))) {
    console.log(`[2/6] Proposing editing plan (preset: ${preset.name})`);
    plan = proposePlan({
      jobId,
      media,
      transcriptsBySource,
      analysis,
      preset,
      cutKinds: opts.cutKinds,
    });
    if (preset.audio?.normalisePerClip) {
      const gains = await computeClipGains(media.sources, preset.audio?.targetLufs ?? -14);
      if (gains.length > 0) plan.audio.clipGains = gains;
    }
    await saveJson(planPath, plan);
    await markDone("plan");
  } else {
    console.log("[2/6] Plan (resumed)");
    plan = await loadJson(planPath);
  }
  if (opts.burnCaptions !== null) {
    plan.audio = { ...(plan.audio ?? {}), burnCaptions: opts.burnCaptions };
  }

  // 3. Validate
  console.log("[3/6] Validating editing plan (schema, reality, sanity)");
  validatePlan(plan, media);
  await markDone("validate");

  // 4. Subtitles & compile
  const srtPath = join(jobDir, "subtitles.srt");
  await writeFile(srtPath, formatSrt(plan.subtitles ?? []), "utf8");
  const includeTimelineCaptions =
    opts.timelineCaptions ?? (plan.audio?.burnCaptions ?? true);
  const compiled = compilePlan(plan, media, {
    includeCaptions: includeTimelineCaptions,
  });
  await saveJson(join(jobDir, "timeline-ops.json"), compiled);
  console.log(
    `[4/6] Compiled ${compiled.ops.length} timeline ops (${plan.cuts.length} cuts, ${plan.subtitles.length} subtitles -> ${includeTimelineCaptions ? "timeline + srt" : "srt file only"})`
  );
  await markDone("compile");

  // 5. Build & Export
  let qc = null;
  const exportPath = join(jobDir, "output.mp4");
  const projectPath = join(jobDir, "project.fcproj");

  if (!opts.noExport) {
    console.log("[5/6] Verifying source hashes & building FilmCraft timeline");
    await verifySourceIntegrity(media);

    const hasVideo = media.sources.some((s) => Boolean(s.video));
    const runBuild = async () => {
      let controlToken = opts.controlToken;
      if (opts.bridge && !controlToken) {
        const bridgeFile = join(ROOT, "workspace", "logs", "bridge.json");
        if (await exists(bridgeFile)) {
          const info = await loadJson(bridgeFile);
          controlToken = info?.token ?? null;
        }
      }
      const client = new FilmCraftClient({
        bridge: opts.bridge,
        controlToken,
        logPath: join(logDir, "filmcraft.jsonl"),
      });
      try {
        await client.start();
        const presetName = await resolveExportPreset(client, preset.export);
        const builder = new TimelineBuilder(client, {
          log: (k, v) => console.log(`  ${k}${v !== undefined ? `: ${v}` : ""}`),
        });
        return await builder.build(compiled, {
          fps: plan.sequence.fps,
          exportPath,
          projectPath,
          preset: presetName,
          burnCaptions: plan.audio?.burnCaptions ?? false,
          captionSidecar: includeTimelineCaptions,
        });
      } finally {
        await client.close();
      }
    };

    await runBuild();
    await markDone("build");

    // 6. QC (retry once on failure)
    console.log("[6/6] Running post-export QC");
    try {
      qc = await qcExport({
        exportPath,
        expectedDurationTicks: compiled.expectedDurationTicks,
        targetLufs: plan.audio?.targetLufs ?? -14,
        requireVideo: hasVideo,
      });
    } catch (err) {
      console.warn(`[qc] First attempt failed (${err.message}); retrying build once...`);
      await runBuild();
      qc = await qcExport({
        exportPath,
        expectedDurationTicks: compiled.expectedDurationTicks,
        targetLufs: plan.audio?.targetLufs ?? -14,
        requireVideo: hasVideo,
      });
    }
    await markDone("qc");
  } else {
    console.log("[5/6] Build & export skipped (--no-export)");
  }

  const report = buildReport({
    jobId,
    presetName: preset.name ?? opts.preset,
    media,
    plan,
    compiled,
    qc,
  });
  await writeReport(jobDir, report);
  await markDone("report");

  console.log(`\nDone! Output locations:`);
  console.log(`  Directory : ${jobDir}`);
  if (!opts.noExport) {
    console.log(`  Video MP4 : ${exportPath}`);
    console.log(`  Project   : ${projectPath}`);
  }
  console.log(`  Subtitles : ${srtPath}`);
  console.log(`  Report    : ${join(jobDir, "report.md")}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  if (err.diagnostics) {
    for (const d of err.diagnostics) {
      console.error(`  - [${d.layer}] ${d.path}: ${d.msg}`);
    }
  }
  process.exit(1);
});
