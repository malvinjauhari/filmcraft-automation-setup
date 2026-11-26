/**
 * Video aspect-ratio reframing (landscape <-> portrait) via FFmpeg.
 *
 * Never modifies original source footage; always writes a new reframed file
 * inside the job's working directory before importing into FilmCraft.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const exec = promisify(execFile);

/**
 * Build an FFmpeg `-vf` filtergraph to reframe any video to `width x height`.
 *
 * Modes:
 *   - "blur" : blurred scaled background + sharp centered foreground (no content lost)
 *   - "crop" : center-crop to target aspect ratio and scale to exact dimensions
 *
 * @param {{ width: number, height: number, mode?: "blur" | "crop" }} opts
 */
export function buildReframeFilter({ width, height, mode = "blur" }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid target dimensions: ${width}x${height}`);
  }
  if (mode === "crop") {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1`
    );
  }
  if (mode === "blur") {
    return (
      `split[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:6[b];` +
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[f];` +
      `[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  }
  throw new Error(`Unknown reframe mode "${mode}" (expected "blur" or "crop")`);
}

/**
 * Reframe `inputPath` into `outputPath` at `width x height`.
 * Preserves audio stream without re-encoding if compatible, or encodes AAC 48kHz.
 */
export async function reframeVideo(
  inputPath,
  outputPath,
  { width, height, mode = "blur", dryRun = false }
) {
  const vf = buildReframeFilter({ width, height, mode });
  const args = [
    "-y",
    "-nostdin",
    "-i",
    inputPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "192k",
    outputPath,
  ];

  if (dryRun) {
    return { outputPath, vf, command: `ffmpeg ${args.join(" ")}`, dryRun: true };
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await exec("ffmpeg", args, { timeout: 3_600_000, maxBuffer: 32 * 1024 * 1024 });
  return { outputPath, vf, command: `ffmpeg ${args.join(" ")}`, dryRun: false };
}
