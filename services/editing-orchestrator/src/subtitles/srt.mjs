/**
 * Indonesian-aware subtitle cue builder and SRT writer.
 *
 * Maps word-level timestamps from source transcripts through the kept ranges
 * of an editing plan so every cue lands at its exact edited-timeline time.
 */

import { normalizeCuts, keptRanges } from "../plan/compile.mjs";
import { floorToFrame, formatSrtTime, secondsToTicks } from "../timeline/time.mjs";

const SENTENCE_END = /[.!?…]$/;

/**
 * Map a source word's [startTicks, endTicks) onto the edited timeline.
 * Returns null if the word's midpoint was cut out.
 */
function mapWordToTimeline(word, segments) {
  const wStart = BigInt(word.startTicks);
  const wEnd = BigInt(word.endTicks);
  const mid = (wStart + wEnd) / 2n;

  for (const seg of segments) {
    if (mid >= seg.srcStart && mid < seg.srcEnd) {
      const clampedStart = wStart < seg.srcStart ? seg.srcStart : wStart;
      const clampedEnd = wEnd > seg.srcEnd ? seg.srcEnd : wEnd;
      const tlStart = seg.tlStart + (clampedStart - seg.srcStart);
      const tlEnd = seg.tlStart + (clampedEnd - seg.srcStart);
      if (tlEnd <= tlStart) return null;
      return {
        text: String(word.text ?? "").trim(),
        startTicks: tlStart,
        endTicks: tlEnd,
      };
    }
  }
  return null;
}

/**
 * Wrap words into at most `maxLines` lines of at most `maxCharsPerLine` chars.
 */
export function wrapSubtitleLines(text, maxCharsPerLine = 42, maxLines = 2) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const lines = [];
  let current = "";

  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines.join("\n");
}

/**
 * Build timeline-aligned subtitle cues from source transcripts + cuts.
 */
export function buildSubtitleCues({
  transcriptsBySource,
  cuts = [],
  mediaSources,
  fps,
  options = {},
}) {
  const maxCharsPerLine = options.maxCharsPerLine ?? 42;
  const maxLines = options.maxLines ?? 2;
  const maxCharsTotal = maxCharsPerLine * maxLines;
  const minCueTicks = secondsToTicks(options.minCueSeconds ?? 1.0);
  const maxCueTicks = secondsToTicks(options.maxCueSeconds ?? 6.0);
  const pauseSplitTicks = secondsToTicks(options.pauseSplitSeconds ?? 0.65);
  const language = options.language ?? "id";

  // Build source -> edited-timeline segment mapping matching compilePlan()
  const tlWords = [];
  let timelineCursor = 0n;

  for (const src of mediaSources) {
    const srcCuts = normalizeCuts(
      cuts.filter((c) => c.sourceIndex === src.index),
      fps
    );
    const keeps = keptRanges(srcCuts, src.durationTicks);
    const segments = [];

    for (const k of keeps) {
      const rawDur = BigInt(k.endTicks) - BigInt(k.startTicks);
      const dur = floorToFrame(rawDur, fps);
      if (dur <= 0n) continue;
      const srcIn = floorToFrame(BigInt(k.startTicks), fps);
      segments.push({
        srcStart: srcIn,
        srcEnd: srcIn + dur,
        tlStart: timelineCursor,
      });
      timelineCursor += dur;
    }

    const tr = transcriptsBySource[src.index];
    const words = tr?.words ?? [];
    for (const w of words) {
      const mapped = mapWordToTimeline(w, segments);
      if (mapped && mapped.text) tlWords.push(mapped);
    }
  }

  if (tlWords.length === 0) return [];

  // Group mapped words into cues
  const cues = [];
  let group = [];
  let charCount = 0;

  const flush = () => {
    if (group.length === 0) return;
    const rawText = group.map((w) => w.text).join(" ");
    const text = wrapSubtitleLines(rawText, maxCharsPerLine, maxLines);
    const startTicks = group[0].startTicks;
    let endTicks = group[group.length - 1].endTicks;
    if (endTicks - startTicks < minCueTicks) {
      endTicks = startTicks + minCueTicks;
    }
    if (endTicks > timelineCursor && timelineCursor > startTicks) {
      endTicks = timelineCursor;
    }
    if (text && endTicks > startTicks) {
      cues.push({
        startTicks: startTicks.toString(),
        endTicks: endTicks.toString(),
        text,
        language,
      });
    }
    group = [];
    charCount = 0;
  };

  for (const w of tlWords) {
    const prev = group[group.length - 1];
    const nextChars = charCount + (group.length > 0 ? 1 : 0) + w.text.length;
    const wouldExceedDur =
      group.length > 0 && w.endTicks - group[0].startTicks > maxCueTicks;
    const longPause = prev && w.startTicks - prev.endTicks > pauseSplitTicks;

    if (group.length > 0 && (nextChars > maxCharsTotal || wouldExceedDur || longPause)) {
      flush();
    }

    group.push(w);
    charCount += (group.length > 1 ? 1 : 0) + w.text.length;

    if (SENTENCE_END.test(w.text) && group.length >= 2) {
      flush();
    }
  }
  flush();

  // Prevent overlapping cues
  for (let i = 0; i < cues.length - 1; i++) {
    const curEnd = BigInt(cues[i].endTicks);
    const nextStart = BigInt(cues[i + 1].startTicks);
    if (curEnd > nextStart) {
      cues[i].endTicks = nextStart.toString();
    }
  }

  return cues.filter((c) => BigInt(c.endTicks) > BigInt(c.startTicks));
}

/** Format subtitle cues into an SRT string. */
export function formatSrt(cues) {
  return (
    cues
      .map((c, idx) => {
        const start = formatSrtTime(c.startTicks);
        const end = formatSrtTime(c.endTicks);
        return `${idx + 1}\n${start} --> ${end}\n${c.text}\n`;
      })
      .join("\n")
      .trimEnd() + (cues.length > 0 ? "\n" : "")
  );
}
