/**
 * Audio loudness measurement and per-clip gain calculation via FFmpeg loudnorm.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Parse the JSON block emitted by ffmpeg's loudnorm filter on stderr.
 */
export function parseLoudnormJson(stderr) {
  const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const inputI = Number(parsed.input_i);
    const inputTp = Number(parsed.input_tp);
    const inputLra = Number(parsed.input_lra);
    if (!Number.isFinite(inputI)) return null;
    return {
      inputLufs: inputI,
      truePeakDb: Number.isFinite(inputTp) ? inputTp : null,
      lra: Number.isFinite(inputLra) ? inputLra : null,
    };
  } catch {
    return null;
  }
}

/**
 * Measure integrated loudness (LUFS) of a media file using ffmpeg.
 */
export async function measureLoudness(filePath, targetLufs = -14) {
  const { stderr } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-af",
      `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
  );
  return parseLoudnormJson(stderr);
}

/**
 * Compute per-source gain adjustments (clamped to [-24, 24] dB) to match targetLufs.
 */
export async function computeClipGains(sources, targetLufs = -14) {
  const gains = [];
  for (const src of sources) {
    if (!src.audio) continue;
    const stats = await measureLoudness(src.path, targetLufs);
    if (!stats || stats.inputLufs <= -70) continue;
    const delta = Math.max(-24, Math.min(24, Number((targetLufs - stats.inputLufs).toFixed(2))));
    if (Math.abs(delta) >= 0.5) {
      gains.push({ sourceIndex: src.index, db: delta });
    }
  }
  return gains;
}
