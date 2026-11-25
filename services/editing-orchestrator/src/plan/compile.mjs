/**
 * Compile a validated editing plan into timeline operations.
 *
 * Strategy: place KEPT ranges back-to-back into a fresh sequence.
 *
 * Why not razor + rippleDelete:
 *   - placement is additive and idempotent; replaying it into a fresh project
 *     always yields the same timeline
 *   - razor/delete is destructive and order-dependent; a failed delete leaves a
 *     corrupt timeline that is hard to detect
 *
 * Given the same plan, this function produces a byte-identical op list.
 */

import { snapToFrame, floorToFrame } from "../timeline/time.mjs";

/** Merge overlapping/adjacent cuts, then sort. Deterministic. */
export function normalizeCuts(cuts, fps) {
  const sorted = cuts
    .map((c) => ({
      ...c,
      startTicks: snapToFrame(BigInt(c.startTicks), fps),
      endTicks: snapToFrame(BigInt(c.endTicks), fps),
    }))
    .filter((c) => c.endTicks > c.startTicks)
    .sort((a, b) =>
      a.startTicks === b.startTicks ? 0 : a.startTicks < b.startTicks ? -1 : 1
    );

  const merged = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.startTicks <= prev.endTicks) {
      // overlap or touch: extend, keep the earlier reason (it is the primary one)
      if (c.endTicks > prev.endTicks) prev.endTicks = c.endTicks;
      prev.mergedCount = (prev.mergedCount ?? 1) + 1;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/**
 * Invert cuts into kept ranges across [0, durationTicks).
 * @returns {{startTicks:bigint,endTicks:bigint}[]}
 */
export function keptRanges(cuts, durationTicks) {
  const out = [];
  let cursor = 0n;
  const dur = BigInt(durationTicks);
  for (const c of cuts) {
    const s = BigInt(c.startTicks);
    const e = BigInt(c.endTicks);
    if (s > cursor) out.push({ startTicks: cursor, endTicks: s });
    if (e > cursor) cursor = e;
  }
  if (cursor < dur) out.push({ startTicks: cursor, endTicks: dur });
  return out;
}

/**
 * Build the `place` ops for one source's kept ranges.
 * Each kept range becomes one clip with sourceIn + duration, laid back to back.
 */
export function compilePlaceOps({
  sourceIndex,
  keeps,
  fps,
  track = "V1",
  audioTrack = "A1",
}) {
  const ops = [];
  let cursor = 0n;

  for (const k of keeps) {
    const rawDur = BigInt(k.endTicks) - BigInt(k.startTicks);
    const dur = floorToFrame(rawDur, fps);
    if (dur <= 0n) continue;

    // Trim the source-in to the frame grid too, so sourceIn + duration never
    // exceeds the source's frame-aligned length.
    const srcIn = floorToFrame(BigInt(k.startTicks), fps);

    ops.push({
      op: "place",
      sourceIndex,
      track,
      audioTrack,
      startTicks: cursor.toString(),
      sourceInTicks: srcIn.toString(),
      durationTicks: dur.toString(),
    });
    cursor += dur;
  }
  return { ops, totalTicks: cursor };
}

/**
 * Compile a whole plan into the timeline-op list.
 * @param {object} plan      validated editing plan
 * @param {object} media     media manifest (for durations + paths)
 * @param {object} [opts]
 * @param {boolean} [opts.includeCaptions=true] whether to emit captionTrack/caption timeline ops
 */
export function compilePlan(plan, media, { includeCaptions = true } = {}) {
  const fps = plan.sequence.fps;
  const ops = [];

  ops.push({ op: "newProject", name: plan.jobId });
  ops.push({
    op: "newSequence",
    name: "Main",
    width: plan.sequence.width,
    height: plan.sequence.height,
    fps,
  });

  ops.push({
    op: "importMedia",
    paths: media.sources.map((s) => s.path),
    sourceIndices: media.sources.map((s) => s.index),
  });

  // Group cuts per source, then compile each source's keeps back to back.
  let cursor = 0n;
  let expectedTotal = 0n;

  for (const source of media.sources) {
    const sourceCuts = normalizeCuts(
      plan.cuts.filter((c) => c.sourceIndex === source.index),
      fps
    );
    const keeps = keptRanges(sourceCuts, BigInt(source.durationTicks));
    const { ops: placeOps, totalTicks } = compilePlaceOps({
      sourceIndex: source.index,
      keeps,
      fps,
    });

    for (const p of placeOps) {
      ops.push({ ...p, startTicks: (cursor + BigInt(p.startTicks)).toString() });
    }
    cursor += totalTicks;
    expectedTotal += totalTicks;
  }

  if (includeCaptions && plan.subtitles?.length) {
    ops.push({ op: "captionTrack", format: "Subtitle", name: "Subtitles", language: "id" });
    for (const s of plan.subtitles) {
      const start = BigInt(s.startTicks);
      const dur = BigInt(s.endTicks) - start;
      if (dur <= 0n) continue;
      ops.push({
        op: "caption",
        startTicks: start.toString(),
        durationTicks: dur.toString(),
        text: s.text,
      });
    }
  }

  for (const g of plan.audio?.clipGains ?? []) {
    ops.push({ op: "gain", sourceIndex: g.sourceIndex, db: g.db });
  }

  for (const ch of plan.chapters ?? []) {
    ops.push({ op: "marker", startTicks: ch.startTicks, name: ch.title });
  }

  return { ops, expectedDurationTicks: expectedTotal.toString() };
}
