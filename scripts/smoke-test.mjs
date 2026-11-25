#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Generates two synthetic clips, builds a plan that cuts a middle range out of
 * each, compiles it, builds it in FilmCraft through the real client + builder,
 * and verifies the output. No real footage, no model, runs in seconds.
 *
 * This is the test that proves the pipeline works, not just that it compiles.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { FilmCraftClient } from "../services/editing-orchestrator/src/filmcraft/client.mjs";
import { TimelineBuilder } from "../services/editing-orchestrator/src/timeline/build.mjs";
import { compilePlan } from "../services/editing-orchestrator/src/plan/compile.mjs";
import { validatePlan } from "../services/editing-orchestrator/src/plan/validate.mjs";
import { secondsToTicks, ticksToSeconds } from "../services/editing-orchestrator/src/timeline/time.mjs";

const exec = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const JOB = "smoke";
const DIR = join(ROOT, "workspace", "projects", JOB);
const INBOX = join(ROOT, "workspace", "inbox", JOB);

const log = (m, d) => console.log(`  ${m}${d ? `: ${d}` : ""}`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`);
  process.exitCode = 1;
};

async function makeClip(path, seconds, pattern, freq) {
  await exec(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      path,
    ],
    { timeout: 180000 }
  );
  const s = await stat(path);
  if (s.size === 0) throw new Error(`ffmpeg produced empty ${path}`);
}

async function main() {
  console.log("\nEnd-to-end smoke test\n");

  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  await mkdir(INBOX, { recursive: true });

  // ---- 1. synthetic footage ---------------------------------------------
  console.log("1. Generating synthetic footage");
  const clipA = join(INBOX, "clipA.mp4");
  const clipB = join(INBOX, "clipB.mp4");
  await makeClip(clipA, 6, "testsrc2", 440);
  await makeClip(clipB, 6, "testsrc", 660);
  log("clipA.mp4", "6s 1920x1080 30fps");
  log("clipB.mp4", "6s 1920x1080 30fps");
  ok("footage ready");

  // ---- 2. media manifest -------------------------------------------------
  console.log("\n2. Building media manifest");
  const sources = [];
  for (const [i, p] of [clipA, clipB].entries()) {
    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-show_format", "-show_streams", p,
    ]);
    const info = JSON.parse(stdout);
    const dur = parseFloat(info.format.duration);
    sources.push({
      index: i,
      path: p,
      sha256: "0".repeat(64),
      bytes: parseInt(info.format.size, 10),
      kind: "video",
      durationTicks: secondsToTicks(dur).toString(),
      durationSeconds: dur,
      video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
      audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    });
  }
  const media = {
    version: "1.0",
    jobId: JOB,
    generatedAt: new Date().toISOString(),
    ticksPerSecond: 254016000000,
    sources,
  };
  await writeFile(join(DIR, "media.json"), JSON.stringify(media, null, 2));
  ok("media.json written");

  // ---- 3. plan with real cuts -------------------------------------------
  console.log("\n3. Building an editing plan (cut 1s..2s from each clip)");
  const plan = {
    version: "1.0",
    jobId: JOB,
    sequence: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    cuts: [
      {
        id: "c1",
        sourceIndex: 0,
        startTicks: secondsToTicks(1).toString(),
        endTicks: secondsToTicks(2).toString(),
        kind: "silence",
        reason: "smoke test: one second of dead air removed",
        confidence: 0.9,
      },
      {
        id: "c2",
        sourceIndex: 1,
        startTicks: secondsToTicks(1).toString(),
        endTicks: secondsToTicks(2).toString(),
        kind: "filler",
        reason: "smoke test: one second of filler removed",
        confidence: 0.85,
      },
    ],
    subtitles: [
      { startTicks: "0", endTicks: secondsToTicks(2).toString(), text: "Halo, ini uji coba.", language: "id" },
      { startTicks: secondsToTicks(2).toString(), endTicks: secondsToTicks(4).toString(), text: "Kedua klip sudah dipotong.", language: "id" },
    ],
    audio: { targetLufs: -14, clipGains: [] },
    chapters: [{ startTicks: "0", title: "Uji Coba" }],
    meta: { generatedBy: "smoke-test", promptVersion: "1" },
  };
  await writeFile(join(DIR, "editing-plan.json"), JSON.stringify(plan, null, 2));

  // ---- 4. validation -----------------------------------------------------
  console.log("\n4. Validating plan");
  try {
    const r = validatePlan(plan, media);
    ok(`valid${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ""}`);
  } catch (e) {
    for (const d of e.diagnostics ?? []) fail(`${d.layer}/${d.path}: ${d.msg}`);
    throw e;
  }

  // prove the validator REJECTS a bad plan
  const badPlan = structuredClone(plan);
  badPlan.cuts[0].endTicks = secondsToTicks(999).toString();
  let rejected = false;
  try {
    validatePlan(badPlan, media);
  } catch {
    rejected = true;
  }
  if (rejected) ok("validator rejects a cut beyond the source (reality check works)");
  else fail("validator accepted a cut beyond the source!");

  // ---- 5. compile --------------------------------------------------------
  console.log("\n5. Compiling plan to timeline ops");
  const compiled = compilePlan(plan, media);
  const expectedSec = ticksToSeconds(compiled.expectedDurationTicks);
  log("ops", compiled.ops.length);
  log("expected duration", `${expectedSec}s`);
  if (Math.abs(expectedSec - 10) > 0.05) {
    fail(`expected ~10s (6-1 + 6-1), got ${expectedSec}s`);
  } else {
    ok("duration math correct: 5s + 5s = 10s");
  }
  await writeFile(join(DIR, "timeline-ops.json"), JSON.stringify(compiled, null, 2));

  // ---- 6. build in FilmCraft --------------------------------------------
  console.log("\n6. Building the timeline in FilmCraft");
  const projectPath = join(DIR, "project.fcproj");
  const exportPath = join(DIR, "output.mp4");
  const client = new FilmCraftClient({
    dataDir: join(ROOT, "workspace", ".filmcraft-data"),
    logPath: join(DIR, "logs", "filmcraft.jsonl"),
  });

  const builder = new TimelineBuilder(client, { log: (m, d) => log(m, d) });
  const result = await builder.build(compiled, {
    fps: 30,
    projectPath,
    exportPath,
    preset: "High Quality 1080p HD",
    burnCaptions: false,
  });
  ok(`built: ${result.clipCount} clips, ${result.durationTicks} ticks`);

  // ---- 7. verify the output ---------------------------------------------
  console.log("\n7. Verifying the rendered output");
  const { stdout: probeOut } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", exportPath,
  ]);
  const out = JSON.parse(probeOut);
  const v = out.streams.find((s) => s.codec_type === "video");
  const a = out.streams.find((s) => s.codec_type === "audio");
  const dur = parseFloat(out.format.duration);

  const checks = [
    ["video codec is h264", v?.codec_name === "h264"],
    ["audio codec is aac", a?.codec_name === "aac"],
    ["resolution 1920x1080", v?.width === 1920 && v?.height === 1080],
    ["duration ~10s", Math.abs(dur - 10) < 0.5],
    ["project file exists", (await stat(projectPath)).size > 0],
  ];
  for (const [name, pass] of checks) pass ? ok(name) : fail(name);
  log("actual duration", `${dur.toFixed(2)}s`);

  // ---- 8. determinism ----------------------------------------------------
  console.log("\n8. Determinism check");
  const compiled2 = compilePlan(plan, media);
  const same = JSON.stringify(compiled) === JSON.stringify(compiled2);
  same ? ok("compiling the same plan twice yields identical ops") : fail("compile is not deterministic");

  console.log(
    process.exitCode === 1
      ? "\n\x1b[31mSMOKE TEST FAILED\x1b[0m\n"
      : `\n\x1b[32mSMOKE TEST PASSED\x1b[0m\n  output: ${exportPath}\n  project: ${projectPath}\n`
  );
}

main().catch((e) => {
  console.error(`\n\x1b[31mSMOKE TEST ERROR: ${e.message}\x1b[0m`);
  if (e.diagnostics) for (const d of e.diagnostics) console.error(`  ${d.layer}/${d.path}: ${d.msg}`);
  console.error(e.stack);
  process.exit(1);
});
