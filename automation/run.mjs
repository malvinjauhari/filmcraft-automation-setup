#!/usr/bin/env node
/**
 * Automation entrypoint: URL -> libreget-cli download -> Video Editor CLI.
 *
 * Keeps downloader logic isolated in `automation/` while delegating all editing
 * to `apps/cli/src/main.mjs` without duplicating any editor code.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadMedia, isUrl } from "./libreget.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function printHelp() {
  console.log(`AI Video Automation (libreget-cli + Video Editor)

Usage:
  npm run automate -- --input <URL|dir|files...> [options]

Downloader Options (handled by automation/libreget.mjs):
  --quality, -q <res>        Video quality for libreget-cli (default: 1080)
  --subs <langs>             Download subtitles via libreget-cli (e.g. id,en)
  --dry-run                  Simulate URL download + editor handoff without running

Video Editor Options (forwarded to apps/cli/src/main.mjs):
  -i, --input <arg...>       YouTube/media URL(s) or local file/directory path(s)
  --preset <name>            Editorial preset: tutorial-id (default), vlog-id
  --job <id>                 Job identifier
  --model <name>             Whisper model: base (default), small
  --cut-kinds <list>         Comma-separated cut kinds (e.g. silence,dead_air)
  --bridge [host:port]       Connect to live FilmCraft GUI (default: 127.0.0.1:7991)
  --resume                   Resume an existing job
  --no-export                Build FilmCraft project without exporting MP4
  --burn-captions            Burn subtitles into exported video
  --no-burn-captions         Export SRT sidecar only
  -h, --help                 Show this help message`);
}

function parseAutomationArgs(argv) {
  const inputs = [];
  const forwarded = [];
  let quality = "1080";
  let subs = null;
  let dryRun = false;
  let help = false;
  let job = null;
  let preset = "tutorial-id";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "-i") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        inputs.push(argv[++i]);
      }
    } else if (a === "--quality" || a === "-q") {
      quality = argv[++i];
    } else if (a === "--subs") {
      subs = argv[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else {
      forwarded.push(a);
      if (a === "--job" && i + 1 < argv.length) {
        job = argv[i + 1];
        forwarded.push(argv[++i]);
      } else if (a === "--preset" && i + 1 < argv.length) {
        preset = argv[i + 1];
        forwarded.push(argv[++i]);
      }
    }
  }

  return { inputs, forwarded, quality, subs, dryRun, help, job, preset };
}

function runEditor(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(ROOT, "apps", "cli", "src", "main.mjs"), ...args], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Video editor exited with code ${code}`));
    });
  });
}

async function main() {
  const opts = parseAutomationArgs(process.argv.slice(2));
  if (opts.help || opts.inputs.length === 0) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const rawDir = join(ROOT, "raw-video");
  const resolvedInputs = [];
  const downloads = [];

  for (const raw of opts.inputs) {
    if (isUrl(raw)) {
      console.log(`[downloader] URL detected -> libreget-cli (${opts.quality}p): ${raw}`);
      const dl = await downloadMedia(raw, {
        rootDir: ROOT,
        outDir: rawDir,
        quality: opts.quality,
        subs: opts.subs,
        dryRun: opts.dryRun,
      });
      if (dl.title) console.log(`  Title   : ${dl.title}`);
      if (dl.chapters?.length) console.log(`  Chapters: ${dl.chapters.length}`);
      console.log(`  File    : ${dl.filePath}`);
      resolvedInputs.push(dl.filePath);
      downloads.push({ url: raw, ...dl });
    } else {
      resolvedInputs.push(raw);
    }
  }

  const firstInput = opts.inputs[0];
  const derivedJob =
    opts.job ??
    (isUrl(firstInput)
      ? `url-${firstInput.replace(/[^a-zA-Z0-9]+/g, "-").slice(-24).replace(/^-|-$/g, "") || "video"}`
      : basename(resolve(firstInput)).replace(/[^a-zA-Z0-9_-]/g, "-"));

  if (opts.dryRun) {
    console.log("\n[DRY-RUN] Automation handoff simulation:");
    console.log(`  1. Downloader  : ${downloads.length > 0 ? downloads[0].command : "skipped (local input)"}`);
    console.log(`  2. Editor CLI  : node apps/cli/src/main.mjs --input ${resolvedInputs.join(" ")} --preset ${opts.preset} --job ${derivedJob}`);
    console.log(`  3. Output Dir  : ${join(ROOT, "workspace", "projects", derivedJob)}`);
    console.log("\n[DRY-RUN] Simulation complete. No files were modified.");
    return;
  }

  if (downloads.length > 0) {
    const metaDir = join(ROOT, "workspace", "projects", derivedJob);
    await mkdir(metaDir, { recursive: true });
    await writeFile(join(metaDir, "download-meta.json"), JSON.stringify(downloads, null, 2) + "\n", "utf8");
  }

  const editorArgs = ["--input", ...resolvedInputs, ...opts.forwarded];
  if (!opts.job) {
    editorArgs.push("--job", derivedJob);
  }
  await runEditor(editorArgs);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
