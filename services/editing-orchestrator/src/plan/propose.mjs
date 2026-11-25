/**
 * Deterministic preset-driven editing plan proposer.
 *
 * Converts media.json + transcript.*.json + analysis.json + preset into a
 * schema-valid EditingPlan ready for validatePlan() and compilePlan().
 */

import { buildSubtitleCues } from "../subtitles/srt.mjs";
import { normalizeCuts } from "./compile.mjs";
import { secondsToTicks } from "../timeline/time.mjs";

const ALLOWED_KINDS = new Set(["silence", "filler", "retake", "mistake", "dead_air"]);

/**
 * Propose a validated-ready EditingPlan from analysis outputs and a preset.
 */
export function proposePlan({
  jobId,
  media,
  transcriptsBySource = {},
  analysis = { sources: [] },
  preset = {},
  cutKinds = null,
  generatedBy = "proposePlan/1.0",
}) {
  const allowedCutKinds = cutKinds ? new Set(cutKinds) : ALLOWED_KINDS;
  const firstVideo = media.sources.find((s) => s.video?.fps > 0);
  const fps = preset.export?.fps ?? firstVideo?.video?.fps ?? 30;
  const sequence = {
    width: 1920,
    height: 1080,
    fps,
    sampleRate: 48000,
  };

  const minCutTicks = secondsToTicks(preset.pacing?.minCutSeconds ?? 0.18);
  const minConfidence = 0.55;
  const totalMediaTicks = media.sources.reduce(
    (acc, s) => acc + BigInt(s.durationTicks),
    0n
  );
  // Stay safely below validate.mjs's 60% removal ceiling.
  const maxRemovalRatio = 0.55;
  const maxRemovedTicks = BigInt(
    Math.floor(Number(totalMediaTicks) * maxRemovalRatio)
  );

  // Collect eligible candidates sorted by confidence desc, then startTicks asc.
  const analysisSources = Array.isArray(analysis?.sources)
    ? analysis.sources
    : analysis && analysis.sourceIndex !== undefined
      ? [analysis]
      : [];

  const rawCandidates = [];
  for (const srcAnalysis of analysisSources) {
    const src = media.sources.find((s) => s.index === srcAnalysis.sourceIndex);
    if (!src) continue;
    const srcDur = BigInt(src.durationTicks);

    for (const cand of srcAnalysis.candidates ?? []) {
      const s = BigInt(cand.startTicks);
      const e = BigInt(cand.endTicks);
      if (s < 0n || e > srcDur || e - s < minCutTicks) continue;
      if ((cand.confidence ?? 0) < minConfidence) continue;
      const kind = ALLOWED_KINDS.has(cand.kind) ? cand.kind : "silence";
      if (!allowedCutKinds.has(kind)) continue;
      const reason =
        typeof cand.reason === "string" && cand.reason.trim().length >= 8
          ? cand.reason.trim()
          : `Automated ${kind} candidate from analysis`;

      rawCandidates.push({
        sourceIndex: srcAnalysis.sourceIndex,
        startTicks: s.toString(),
        endTicks: e.toString(),
        kind,
        reason,
        confidence: Math.max(0, Math.min(1, Number(cand.confidence))),
        candidateId: cand.id,
      });
    }
  }

  rawCandidates.sort((a, b) => b.confidence - a.confidence);

  // Greedily accept candidates within the overall removal budget, then normalize per source.
  const accepted = [];
  let removedBudget = 0n;
  for (const c of rawCandidates) {
    const dur = BigInt(c.endTicks) - BigInt(c.startTicks);
    if (removedBudget + dur > maxRemovedTicks) continue;
    accepted.push(c);
    removedBudget += dur;
  }

  const cuts = [];
  let cutCounter = 1;
  for (const src of media.sources) {
    const normalized = normalizeCuts(
      accepted.filter((c) => c.sourceIndex === src.index),
      fps
    );
    for (const c of normalized) {
      if (c.endTicks - c.startTicks < minCutTicks) continue;
      cuts.push({
        id: `c${cutCounter++}`,
        sourceIndex: c.sourceIndex,
        startTicks: c.startTicks.toString(),
        endTicks: c.endTicks.toString(),
        kind: c.kind,
        reason: c.reason,
        confidence: c.confidence,
        ...(c.candidateId ? { candidateId: c.candidateId } : {}),
      });
    }
  }

  const subtitlesEnabled = preset.subtitles?.enabled !== false;
  const subtitles = subtitlesEnabled
    ? buildSubtitleCues({
        transcriptsBySource,
        cuts,
        mediaSources: media.sources,
        fps,
        options: preset.subtitles ?? {},
      })
    : [];

  const chapters = [];
  if (preset.chapters?.enabled && preset.chapters?.fromSceneCuts) {
    const minChapterTicks = secondsToTicks(preset.chapters?.minChapterSeconds ?? 45);
    let tlOffset = 0n;
    let lastChapterTick = -minChapterTicks;
    let chapIdx = 1;

    for (const src of media.sources) {
      const srcAnalysis = analysisSources.find(
        (a) => a.sourceIndex === src.index
      );
      for (const sc of srcAnalysis?.scenes ?? []) {
        const t = tlOffset + BigInt(sc.startTicks);
        if (t - lastChapterTick >= minChapterTicks) {
          chapters.push({
            startTicks: t.toString(),
            title: `Section ${chapIdx++}`,
          });
          lastChapterTick = t;
        }
      }
      tlOffset += BigInt(src.durationTicks);
    }
  }

  return {
    version: "1.0",
    jobId,
    sequence,
    cuts,
    subtitles,
    audio: {
      targetLufs: preset.audio?.targetLufs ?? -14,
      burnCaptions: preset.subtitles?.burnIn ?? true,
    },
    ...(chapters.length > 0 ? { chapters } : {}),
    meta: {
      generatedBy,
      promptVersion: "1.0",
      notes: `Preset: ${preset.name ?? "default"}`,
    },
  };
}
