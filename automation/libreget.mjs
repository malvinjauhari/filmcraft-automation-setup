/**
 * LibreGet CLI wrapper (`libreget info` & `libreget download`).
 *
 * Uses only Node.js builtins (`node:child_process`, `node:fs/promises`, `node:path`)
 * to keep zero external runtime dependencies.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve } from "node:path";

const exec = promisify(execFile);
const MEDIA_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".aac"]);

/**
 * Return true if `input` looks like an HTTP(S) URL.
 * @param {string} input
 */
export function isUrl(input) {
  return /^https?:\/\/\S+$/i.test(String(input ?? "").trim());
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `libreget` CLI binary:
 *   1. `<rootDir>/bin/libreget`
 *   2. `~/.local/bin/libreget`
 *   3. `libreget` or `libreget-cli` in `PATH`
 */
export async function resolveLibregetBin(rootDir) {
  const candidates = [
    join(rootDir, "bin", "libreget"),
    process.env.HOME ? join(process.env.HOME, ".local", "bin", "libreget") : null,
  ].filter(Boolean);

  for (const c of candidates) {
    if (await isExecutable(c)) return c;
  }

  for (const name of ["libreget", "libreget-cli"]) {
    try {
      const { stdout } = await exec("which", [name], { timeout: 5000 });
      const found = stdout.trim();
      if (found) return found;
    } catch {
      // keep searching
    }
  }
  return null;
}

/**
 * Parse `libreget info <url>` output (supports JSON or human-readable text).
 * @param {string} raw
 */
export function parseLibregetInfo(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { title: null, chapters: [], raw: "" };

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return {
        title: parsed.title ?? null,
        durationSeconds: parsed.duration ?? null,
        chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [],
        raw: trimmed,
      };
    } catch {
      // fall through to text parser
    }
  }

  let title = null;
  const chapters = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*Title\s*:\s*(.+)$/i);
    if (titleMatch && !title) {
      title = titleMatch[1].trim();
    }
    const chapMatch = line.match(/^\s*(?:\[\s*)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*\])?\s+[-–:]?\s*(.+)$/);
    if (chapMatch) {
      chapters.push({ timestamp: chapMatch[1], title: chapMatch[2].trim() });
    }
  }
  return { title, chapters, raw: trimmed };
}

/**
 * Inspect a URL with `libreget info <url>`.
 */
export async function getMediaInfo(url, { rootDir, bin = null, dryRun = false } = {}) {
  if (dryRun) {
    return {
      title: "Simulated LibreGet Video (dry-run)",
      chapters: [],
      raw: `[dry-run] libreget info ${url}`,
      dryRun: true,
    };
  }
  const exe = bin ?? (await resolveLibregetBin(rootDir));
  if (!exe) {
    throw new Error(
      "libreget-cli binary not found. Run `./setup.sh --full` to install bin/libreget."
    );
  }
  const { stdout } = await exec(exe, ["info", url], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return parseLibregetInfo(stdout);
}

async function listMediaFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      if (e.isFile() && MEDIA_EXTS.has(extname(e.name).toLowerCase())) {
        const p = join(dir, e.name);
        const st = await stat(p);
        files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Download media from `url` into `outDir` using `libreget download`.
 * Returns `{ filePath, title, chapters, info, dryRun }`.
 */
export async function downloadMedia(
  url,
  { rootDir, outDir, quality = 1080, subs = null, audioOnly = false, bin = null, dryRun = false } = {}
) {
  const targetDir = resolve(outDir ?? join(rootDir, "workspace", "raw-video"));
  await mkdir(targetDir, { recursive: true });

  const info = await getMediaInfo(url, { rootDir, bin, dryRun });
  const args = ["download", url, "-q", String(quality), "-o", targetDir];
  if (audioOnly) args.push("--audio-only");
  if (subs) args.push("--subs", subs);

  if (dryRun) {
    return {
      filePath: join(targetDir, "dry-run-download.mp4"),
      title: info.title,
      chapters: info.chapters,
      info,
      command: `libreget ${args.join(" ")}`,
      dryRun: true,
    };
  }

  const exe = bin ?? (await resolveLibregetBin(rootDir));
  if (!exe) {
    throw new Error(
      "libreget-cli binary not found. Run `./setup.sh --full` to install bin/libreget."
    );
  }

  const before = new Map((await listMediaFiles(targetDir)).map((f) => [f.path, f.mtimeMs]));
  await exec(exe, args, { timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
  const after = await listMediaFiles(targetDir);

  const createdOrUpdated = after
    .filter((f) => !before.has(f.path) || f.mtimeMs > before.get(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const picked = createdOrUpdated[0] ?? after.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!picked) {
    throw new Error(`libreget download finished but no media file found in ${targetDir}`);
  }

  return {
    filePath: picked.path,
    title: info.title,
    chapters: info.chapters,
    info,
    command: `${exe} ${args.join(" ")}`,
    dryRun: false,
  };
}
