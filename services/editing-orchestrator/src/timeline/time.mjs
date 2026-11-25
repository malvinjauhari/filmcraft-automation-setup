/**
 * Time model. FilmCraft's base unit is the tick.
 *   1 second = 254_016_000_000 ticks  (48000 x 5292)
 *
 * All tick arithmetic uses BigInt. JS numbers lose integer precision above
 * 2^53 (~9.0e15); an hour of ticks is ~9.1e14, and sums of them overflow.
 */

export const TICKS_PER_SECOND = 254_016_000_000n;
export const TICKS_PER_SECOND_NUM = 254016000000;

/** seconds (float) -> ticks (bigint). Single rounding point in the system. */
export function secondsToTicks(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw new TypeError(`secondsToTicks: expected finite number, got ${seconds}`);
  }
  if (seconds < 0) throw new RangeError(`secondsToTicks: negative ${seconds}`);
  return BigInt(Math.round(seconds * TICKS_PER_SECOND_NUM));
}

/** ticks (bigint|string|number) -> seconds (float). Display/API boundary only. */
export function ticksToSeconds(ticks) {
  const t = BigInt(ticks);
  return Number(t) / TICKS_PER_SECOND_NUM;
}

/** Duration of one frame in ticks, rounded. 30fps -> exactly 8_467_200_000. */
export function ticksPerFrame(fps) {
  if (!(fps > 0)) throw new RangeError(`ticksPerFrame: bad fps ${fps}`);
  return BigInt(Math.round(TICKS_PER_SECOND_NUM / fps));
}

/** Snap a tick value to the nearest frame boundary. */
export function snapToFrame(ticks, fps) {
  const t = BigInt(ticks);
  const f = ticksPerFrame(fps);
  const rem = t % f;
  const base = t - rem;
  return rem * 2n >= f ? base + f : base;
}

/** Floor a tick value to a frame boundary. */
export function floorToFrame(ticks, fps) {
  const t = BigInt(ticks);
  const f = ticksPerFrame(fps);
  return t - (t % f);
}

/** Frame index for a tick value. */
export function ticksToFrame(ticks, fps) {
  return Number(BigInt(ticks) / ticksPerFrame(fps));
}

/** Ticks as a whole number of frames. */
export function frameToTicks(frame, fps) {
  return BigInt(Math.round(frame)) * ticksPerFrame(fps);
}

/** "HH:MM:SS.mmm" for reports and SRT. */
export function formatTimecode(ticks, fps) {
  const total = ticksToSeconds(ticks);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s
    .toFixed(3)
    .padStart(6, "0")}`;
}

/** SRT timestamp "HH:MM:SS,mmm". */
export function formatSrtTime(ticks) {
  const total = ticksToSeconds(ticks);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s
  ).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
