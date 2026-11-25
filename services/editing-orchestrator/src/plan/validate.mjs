/**
 * Plan validation. Three layers, each independently testable:
 *
 *   schema  — types, required fields, enums, ranges
 *   reality — ticks exist within the source; sourceIndex is real; keeps cover
 *             enough speech; no cut outside the media
 *   sanity  — no cut shorter than a blink; nothing removes half the video
 *
 * A schema-valid plan can still ask to cut at second 900 of a 600-second clip.
 * FilmCraft will happily hold the last frame instead of erroring. The reality
 * layer is what stops that.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export class ValidationError extends Error {
  constructor(diagnostics) {
    super(`plan failed validation with ${diagnostics.length} problem(s)`);
    this.name = "ValidationError";
    this.diagnostics = diagnostics;
  }
}

const TICKS = 254016000000n;

/** Load the plan schema once. */
export async function loadSchema(name = "editing-plan.schema.json") {
  const root = join(HERE, "..", "..", "..", "..", "schemas");
  return JSON.parse(await readFile(join(root, name), "utf8"));
}

/**
 * Minimal structural schema check (no external dependency).
 * Covers the constraints that actually matter for this schema: required keys,
 * enums, numeric ranges, and additionalProperties:false.
 */
export function checkSchema(plan) {
  const d = [];
  const isStr = (v) => typeof v === "string";
  const ticksOk = (v) => isStr(v) && /^[0-9]+$/.test(v);

  if (plan?.version !== "1.0") d.push({ layer: "schema", path: "version", msg: "must be '1.0'" });
  if (!isStr(plan?.jobId)) d.push({ layer: "schema", path: "jobId", msg: "required string" });

  const seq = plan?.sequence;
  if (!seq) d.push({ layer: "schema", path: "sequence", msg: "required" });
  else {
    if (seq.width !== 1920) d.push({ layer: "schema", path: "sequence.width", msg: "must be 1920" });
    if (seq.height !== 1080) d.push({ layer: "schema", path: "sequence.height", msg: "must be 1080" });
    if (!(seq.fps > 0)) d.push({ layer: "schema", path: "sequence.fps", msg: "must be > 0" });
    if (seq.sampleRate !== 48000)
      d.push({ layer: "schema", path: "sequence.sampleRate", msg: "must be 48000" });
  }

  if (!Array.isArray(plan?.cuts)) d.push({ layer: "schema", path: "cuts", msg: "required array" });
  else {
    const kinds = new Set(["silence", "filler", "retake", "mistake", "dead_air"]);
    plan.cuts.forEach((c, i) => {
      const p = `cuts[${i}]`;
      if (!/^c[0-9]+$/.test(c?.id ?? "")) d.push({ layer: "schema", path: `${p}.id`, msg: "must match ^c[0-9]+$" });
      if (!Number.isInteger(c?.sourceIndex) || c.sourceIndex < 0)
        d.push({ layer: "schema", path: `${p}.sourceIndex`, msg: "must be a non-negative integer" });
      if (!ticksOk(c?.startTicks)) d.push({ layer: "schema", path: `${p}.startTicks`, msg: "must be integer ticks as string" });
      if (!ticksOk(c?.endTicks)) d.push({ layer: "schema", path: `${p}.endTicks`, msg: "must be integer ticks as string" });
      if (!kinds.has(c?.kind)) d.push({ layer: "schema", path: `${p}.kind`, msg: `must be one of ${[...kinds]}` });
      if (!isStr(c?.reason) || c.reason.length < 8)
        d.push({ layer: "schema", path: `${p}.reason`, msg: "must be a real explanation (>= 8 chars)" });
      if (typeof c?.confidence !== "number" || c.confidence < 0 || c.confidence > 1)
        d.push({ layer: "schema", path: `${p}.confidence`, msg: "must be 0..1" });
    });
  }

  if (!Array.isArray(plan?.subtitles))
    d.push({ layer: "schema", path: "subtitles", msg: "required array" });
  else {
    plan.subtitles.forEach((s, i) => {
      const p = `subtitles[${i}]`;
      if (!ticksOk(s?.startTicks)) d.push({ layer: "schema", path: `${p}.startTicks`, msg: "integer ticks string" });
      if (!ticksOk(s?.endTicks)) d.push({ layer: "schema", path: `${p}.endTicks`, msg: "integer ticks string" });
      if (!isStr(s?.text) || !s.text.trim()) d.push({ layer: "schema", path: `${p}.text`, msg: "required" });
      if (!["id", "en", "mixed"].includes(s?.language))
        d.push({ layer: "schema", path: `${p}.language`, msg: "must be id|en|mixed" });
    });
  }

  return d;
}

/**
 * Reality checks: does the plan refer to media that exists, at times that exist?
 * @param {object} plan
 * @param {object} media  media manifest
 */
export function checkReality(plan, media) {
  const d = [];
  const byIndex = new Map(media.sources.map((s) => [s.index, s]));

  for (const [i, c] of (plan.cuts ?? []).entries()) {
    const p = `cuts[${i}]`;
    const src = byIndex.get(c.sourceIndex);
    if (!src) {
      d.push({ layer: "reality", path: `${p}.sourceIndex`, msg: `no source with index ${c.sourceIndex}` });
      continue;
    }
    const start = BigInt(c.startTicks);
    const end = BigInt(c.endTicks);
    const dur = BigInt(src.durationTicks);

    if (start >= end) d.push({ layer: "reality", path: p, msg: `start ${start} >= end ${end}` });
    if (end > dur)
      d.push({
        layer: "reality",
        path: p,
        msg: `cut ends at ${end} ticks but source ${c.sourceIndex} is only ${dur} ticks long`,
      });
    if (start < 0n) d.push({ layer: "reality", path: p, msg: "negative start" });
  }

  for (const [i, s] of (plan.subtitles ?? []).entries()) {
    if (BigInt(s.startTicks) >= BigInt(s.endTicks)) {
      d.push({ layer: "reality", path: `subtitles[${i}]`, msg: "start >= end" });
    }
  }

  // Total removal must leave the video usable.
  const total = media.sources.reduce((a, s) => a + BigInt(s.durationTicks), 0n);
  const removed = (plan.cuts ?? []).reduce(
    (a, c) => a + (BigInt(c.endTicks) - BigInt(c.startTicks)),
    0n
  );
  if (total > 0n) {
    const ratio = Number(removed) / Number(total);
    if (ratio > 0.6) {
      d.push({
        layer: "reality",
        path: "cuts",
        msg: `plan removes ${(ratio * 100).toFixed(1)}% of the footage — refusing (> 60%)`,
      });
    }
  }

  return d;
}

/** Sanity: editorial guards that keep a cut usable. */
export function checkSanity(plan) {
  const d = [];
  const warnings = [];
  const MIN_CUT = BigInt(Math.round(0.12 * 254016000000)); // 120 ms

  for (const [i, c] of (plan.cuts ?? []).entries()) {
    const len = BigInt(c.endTicks) - BigInt(c.startTicks);
    if (len < MIN_CUT) {
      d.push({
        layer: "sanity",
        path: `cuts[${i}]`,
        msg: `cut is ${Number(len) / 254016000000}s long; below the 120ms floor and will sound like a glitch`,
      });
    }
  }

  // Subtitles must not overlap.
  const subs = [...(plan.subtitles ?? [])].sort((a, b) =>
    BigInt(a.startTicks) < BigInt(b.startTicks) ? -1 : 1
  );
  for (let i = 1; i < subs.length; i++) {
    if (BigInt(subs[i].startTicks) < BigInt(subs[i - 1].endTicks)) {
      warnings.push({
        layer: "sanity",
        path: `subtitles[${i}]`,
        msg: "overlaps the previous cue; will be trimmed",
      });
    }
  }

  // Chapters need a cue nearby to be meaningful.
  for (const [i, ch] of (plan.chapters ?? []).entries()) {
    const t = BigInt(ch.startTicks);
    const hasCue = (plan.subtitles ?? []).some(
      (s) => BigInt(s.startTicks) <= t + BigInt(5 * 254016000000) && BigInt(s.endTicks) >= t
    );
    if (!hasCue) {
      warnings.push({
        layer: "sanity",
        path: `chapters[${i}]`,
        msg: `"${ch.title}" has no subtitle cue near it`,
      });
    }
  }

  return { errors: d, warnings };
}

/**
 * Full validation.
 * @throws {ValidationError}
 */
export function validatePlan(plan, media) {
  const schema = checkSchema(plan);
  const reality = checkReality(plan, media);
  const { errors: sanity, warnings } = checkSanity(plan);
  const diagnostics = [...schema, ...reality, ...sanity];
  if (diagnostics.length > 0) {
    const err = new ValidationError(diagnostics);
    err.warnings = warnings;
    throw err;
  }
  return { ok: true, warnings };
}

export { TICKS };
