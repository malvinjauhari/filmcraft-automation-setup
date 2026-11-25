/**
 * Read-back assertions.
 *
 * FilmCraft returns `null`/`{}` for a successful command and still returns
 * success when a parameter was silently ignored. The only reliable check is to
 * read the state back and compare.
 *
 * Every function here throws TimelineAssertionError on mismatch, which halts the
 * job BEFORE an export can encode a wrong timeline.
 */

import { TimelineAssertionError } from "./client.mjs";
import { ticksToFrame } from "../timeline/time.mjs";

/**
 * Resolve a track reference ("V1", "A1", "Video 1", or a numeric id) to the
 * track object in a sequence_inspect result.
 *
 * Note: FilmCraft commands address tracks as "V1"/"A1", but sequence_inspect
 * NAMES them "Video 1"/"Audio 1". Matching on name === "V1" silently returns
 * nothing — which is how a placement assertion can fail on a good placement.
 */
export function resolveTrack(sequence, ref) {
  const video = sequence.video ?? [];
  const audio = sequence.audio ?? [];
  const s = String(ref);

  const kindMatch = /^([VA])(\d+)$/.exec(s);
  if (kindMatch) {
    const list = kindMatch[1] === "V" ? video : audio;
    const idx = Number(kindMatch[2]) - 1; // V1 is the first track
    return list[idx] ?? null;
  }

  return [...video, ...audio].find((t) => t.name === s || String(t.id) === s) ?? null;
}

/** All clips on a track, sorted by start. */
export function clipsOn(sequence, trackRef) {
  const track = resolveTrack(sequence, trackRef);
  if (!track) return [];
  return [...track.items].sort((a, b) => Number(a.start) - Number(b.start));
}

/**
 * Assert the last clip on a track starts at the expected position.
 * This is THE check that catches the `time:{"seconds":N}` trap.
 */
export function assertClipStartsAt(sequence, { track, startTicks, command }) {
  const clips = clipsOn(sequence, track);
  if (clips.length === 0) {
    throw new TimelineAssertionError(`no clips on ${track}`, {
      expected: startTicks,
      actual: null,
      command,
    });
  }
  const last = clips[clips.length - 1];
  const actual = BigInt(last.start);
  const expected = BigInt(startTicks);
  if (actual !== expected) {
    throw new TimelineAssertionError(
      `clip on ${track} starts at ${actual} ticks (${ticksToFrame(actual, 30)}f), ` +
        `expected ${expected} (${ticksToFrame(expected, 30)}f). ` +
        `Most likely cause: \`seconds\` was nested under \`time\` and silently ignored.`,
      { expected: expected.toString(), actual: actual.toString(), command }
    );
  }
  return last;
}

/** Assert the sequence duration equals the sum of kept ranges. */
export function assertDuration(sequence, { expectedTicks, command, toleranceTicks = 0n }) {
  const actual = BigInt(sequence.duration);
  const expected = BigInt(expectedTicks);
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > BigInt(toleranceTicks)) {
    throw new TimelineAssertionError(
      `sequence duration ${actual} ticks, expected ${expected} (off by ${diff})`,
      { expected: expected.toString(), actual: actual.toString(), command }
    );
  }
  return actual;
}

/** Assert a clip count on a track. */
export function assertClipCount(sequence, { track, count, command }) {
  const actual = clipsOn(sequence, track).length;
  if (actual !== count) {
    throw new TimelineAssertionError(`${track} has ${actual} clips, expected ${count}`, {
      expected: count,
      actual,
      command,
    });
  }
}

/** Assert an import returned one item per path. */
export function assertImport(result, { expectedCount, command }) {
  const items = result?.items ?? [];
  if (items.length !== expectedCount) {
    throw new TimelineAssertionError(
      `imported ${items.length} items, expected ${expectedCount}. ` +
        `Errors: ${JSON.stringify(result?.errors ?? [])}`,
      { expected: expectedCount, actual: items.length, command }
    );
  }
  if ((result?.errors ?? []).length > 0) {
    throw new TimelineAssertionError(`import reported errors: ${JSON.stringify(result.errors)}`, {
      command,
    });
  }
  return items;
}

/** Assert a save actually cleared the dirty flag. */
export async function assertSaved(client, command) {
  const project = await client.projectInspect();
  if (project.dirty === true) {
    throw new TimelineAssertionError("project still dirty after saveAs", {
      expected: false,
      actual: true,
      command,
    });
  }
  return project;
}

/** Assert an export wrote a file and touched no offline media. */
export function assertExport(result, { command }) {
  if ((result?.offlineMedia ?? []).length > 0) {
    throw new TimelineAssertionError(
      `export used offline media: ${JSON.stringify(result.offlineMedia)}. ` +
        `Never accept this — the render contains placeholder frames.`,
      { command }
    );
  }
  if (!result?.path) {
    throw new TimelineAssertionError("export returned no path", { command });
  }
  return result.path;
}

/** Assert a caption cue exists with the given text at the given start. */
export function assertCaption(cues, { text, startTicks, command }) {
  const found = (cues ?? []).find(
    (c) => c.text === text && BigInt(c.start) === BigInt(startTicks)
  );
  if (!found) {
    throw new TimelineAssertionError(
      `caption "${text.slice(0, 40)}" not found at ${startTicks} ticks`,
      { expected: startTicks, actual: (cues ?? []).length, command }
    );
  }
  return found;
}
