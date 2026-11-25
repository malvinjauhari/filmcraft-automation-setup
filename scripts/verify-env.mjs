#!/usr/bin/env node
/**
 * Verify the environment can run the pipeline.
 *
 * Checks binaries, versions, every FilmCraft command we depend on, and that
 * the export preset we need actually exists. Fails loudly rather than letting
 * the pipeline discover a missing capability at export time.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const exec = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const VENV = `${ROOT}.venv/bin/python`;

const REQUIRED_COMMANDS = [
  "file.newProject",
  "file.newSequence",
  "file.import",
  "timeline.place",
  "timeline.razor",
  "edit.rippleDelete",
  "timeline.trim",
  "clip.audioGain",
  "captions.newTrack",
  "captions.add",
  "captions.export",
  "markers.add",
  "file.saveAs",
  "file.exportMedia",
  "file.exportFrame",
  "export.presets.list",
  "sequence.inspect",
  "project.inspect",
  "captions.list",
];

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

let failures = 0;

async function checkBinaries() {
  console.log("\nBinaries");
  const bins = [
    ["filmcraft", ["--version"]],
    ["filmcraft-cli", ["--version"]],
    ["ffmpeg", ["-version"]],
    ["ffprobe", ["-version"]],
    ["node", ["--version"]],
  ];
  for (const [bin, args] of bins) {
    try {
      const { stdout } = await exec(bin, args, { timeout: 15000 });
      ok(`${bin}: ${stdout.split("\n")[0].trim()}`);
    } catch {
      bad(`${bin} not found or not runnable`);
      failures++;
    }
  }
}

async function checkPython() {
  console.log("\nPython (analysis layer)");
  if (!existsSync(VENV)) {
    bad(`venv missing at ${VENV} — run: python3 -m venv .venv && .venv/bin/pip install faster-whisper scenedetect pydantic numpy jsonschema`);
    failures++;
    return;
  }
  const probe = `
import importlib, json
mods = ["faster_whisper","scenedetect","pydantic","numpy","jsonschema"]
out = {}
for m in mods:
    try:
        mod = importlib.import_module(m)
        out[m] = getattr(mod, "__version__", "?")
    except Exception as e:
        out[m] = None
try:
    from faster_whisper.vad import VadOptions
    out["silero_vad_onnx"] = True
except Exception:
    out["silero_vad_onnx"] = False
print(json.dumps(out))
`;
  try {
    const { stdout } = await exec(VENV, ["-c", probe], { timeout: 60000 });
    const r = JSON.parse(stdout);
    for (const m of ["faster_whisper", "scenedetect", "pydantic", "numpy", "jsonschema"]) {
      if (r[m]) ok(`${m} ${r[m]}`);
      else {
        bad(`${m} missing`);
        failures++;
      }
    }
    if (r.silero_vad_onnx) ok("Silero VAD (ONNX, bundled) available");
    else {
      bad("Silero VAD unavailable in faster_whisper");
      failures++;
    }
  } catch (e) {
    bad(`python probe failed: ${e.message}`);
    failures++;
  }
}

async function checkFilmCraftCommands() {
  console.log("\nFilmCraft commands");
  let catalog;
  try {
    const { stdout } = await exec("/usr/bin/filmcraft-cli", ["commands", "--json"], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120000,
    });
    catalog = JSON.parse(stdout);
  } catch (e) {
    bad(`cannot list commands: ${e.message}`);
    failures++;
    return;
  }
  const ids = new Set(catalog.map((c) => c.id));
  ok(`${catalog.length} commands in ${new Set(catalog.map((c) => c.id.split(".")[0])).size} namespaces`);

  let missing = 0;
  for (const id of REQUIRED_COMMANDS) {
    if (!ids.has(id)) {
      bad(`missing command: ${id}`);
      missing++;
      failures++;
    }
  }
  if (missing === 0) ok(`all ${REQUIRED_COMMANDS.length} required commands present`);
}

async function checkPresets() {
  console.log("\nExport presets");
  try {
    const { stdout } = await exec("/usr/bin/filmcraft-cli", ["export", "--list-presets"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    });
    const presets = JSON.parse(stdout);
    const h264_1080 = presets.filter(
      (p) => p.format === "h264" && p.frameSize?.[0] === 1920 && p.frameSize?.[1] === 1080
    );
    if (h264_1080.length > 0) {
      ok(`${presets.length} presets; 1080p H.264 available: "${h264_1080[0].name}"`);
    } else {
      warn(`${presets.length} presets but no 1920x1080 H.264 preset; will need explicit settings`);
    }
  } catch (e) {
    bad(`cannot list presets: ${e.message}`);
    failures++;
  }
}

async function checkMedia() {
  console.log("\nWorkspace");
  for (const d of ["workspace/inbox", "workspace/projects", "workspace/renders", "workspace/logs"]) {
    if (existsSync(`${ROOT}${d}`)) ok(`${d}`);
    else {
      warn(`${d} missing (will be created on first run)`);
    }
  }
}

console.log("Environment verification for ai-video-editor");
await checkBinaries();
await checkPython();
await checkFilmCraftCommands();
await checkPresets();
await checkMedia();

console.log(
  failures === 0
    ? "\n\x1b[32mAll checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
