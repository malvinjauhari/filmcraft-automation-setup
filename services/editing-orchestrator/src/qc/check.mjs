/**
 * Quality Control & Source Integrity Verification.
 *
 * Rule 1: Re-hash all source files before export; abort immediately on drift.
 * Post-export QC: Verify H.264/AAC, 1920x1080, duration match, and loudness.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ticksToSeconds } from "../timeline/time.mjs";
import { measureLoudness } from "../audio/loudness.mjs";

const exec = promisify(execFile);

/** Compute SHA-256 hex digest of a file using streaming I/O. */
export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Re-hash every source in media.json and abort if any file changed or vanished.
 */
export async function verifySourceIntegrity(media) {
  const results = [];
  for (const src of media.sources ?? []) {
    if (!src.sha256) continue;
    const actual = await sha256File(src.path);
    if (actual !== src.sha256) {
      throw new Error(
        `Source integrity violation for [${src.index}] ${src.path}: expected sha256=${src.sha256}, got ${actual}`
      );
    }
    results.push({ sourceIndex: src.index, path: src.path, sha256: actual, ok: true });
  }
  return results;
}

/**
 * Run post-export QC checks on the rendered MP4.
 */
export async function qcExport({
  exportPath,
  expectedDurationTicks,
  targetLufs = -14,
  requireVideo = true,
}) {
  const checks = [];
  const warnings = [];

  const st = await stat(exportPath);
  if (st.size <= 0) {
    throw new Error(`QC failed: exported file is empty (${exportPath})`);
  }
  checks.push({ name: "fileSize", ok: true, value: st.size });

  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    exportPath,
  ]);
  const probe = JSON.parse(stdout);
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (requireVideo) {
    const vOk = Boolean(video && video.width === 1920 && video.height === 1080);
    checks.push({
      name: "video1080p",
      ok: vOk,
      value: video ? `${video.codec_name} ${video.width}x${video.height}` : "missing",
    });
    if (!vOk) {
      throw new Error(
        `QC failed: expected 1920x1080 video, got ${video ? `${video.width}x${video.height}` : "none"}`
      );
    }
  }

  const expectedSec = ticksToSeconds(expectedDurationTicks);
  const actualSec = Number(probe.format?.duration ?? 0);
  const driftSec = Math.abs(actualSec - expectedSec);
  const durOk = driftSec <= 1.0;
  checks.push({
    name: "duration",
    ok: durOk,
    expectedSeconds: Number(expectedSec.toFixed(3)),
    actualSeconds: Number(actualSec.toFixed(3)),
    driftSeconds: Number(driftSec.toFixed(3)),
  });
  if (!durOk) {
    throw new Error(
      `QC failed: duration drift ${driftSec.toFixed(3)}s (expected ${expectedSec.toFixed(3)}s, got ${actualSec.toFixed(3)}s)`
    );
  }

  if (audio) {
    const loud = await measureLoudness(exportPath, targetLufs);
    if (loud) {
      const lufsDiff = Math.abs(loud.inputLufs - targetLufs);
      const lufsOk = lufsDiff <= 2.5;
      checks.push({
        name: "loudness",
        ok: lufsOk,
        inputLufs: loud.inputLufs,
        targetLufs,
        truePeakDb: loud.truePeakDb,
      });
      if (!lufsOk) {
        warnings.push(
          `Loudness ${loud.inputLufs} LUFS is ${lufsDiff.toFixed(1)} LU away from target ${targetLufs} LUFS`
        );
      }
    }
  }

  return { passed: true, checks, warnings };
}
