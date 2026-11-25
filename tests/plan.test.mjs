import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCuts,
  keptRanges,
  compilePlaceOps,
  compilePlan,
} from "../services/editing-orchestrator/src/plan/compile.mjs";
import { validatePlan, checkReality } from "../services/editing-orchestrator/src/plan/validate.mjs";
import { secondsToTicks, ticksToSeconds } from "../services/editing-orchestrator/src/timeline/time.mjs";

const FPS = 30;
const T = (s) => secondsToTicks(s);

const media = {
  version: "1.0",
  jobId: "t",
  generatedAt: new Date().toISOString(),
  sources: [
    { index: 0, path: "/a.mp4", sha256: "0".repeat(64), bytes: 1, kind: "video",
      durationTicks: T(6).toString(), durationSeconds: 6 },
    { index: 1, path: "/b.mp4", sha256: "1".repeat(64), bytes: 1, kind: "video",
      durationTicks: T(6).toString(), durationSeconds: 6 },
  ],
};

const plan = (cuts) => ({
  version: "1.0",
  jobId: "t",
  sequence: { width: 1920, height: 1080, fps: FPS, sampleRate: 48000 },
  cuts,
  subtitles: [],
});

const cut = (id, src, a, b) => ({
  id,
  sourceIndex: src,
  startTicks: T(a).toString(),
  endTicks: T(b).toString(),
  kind: "silence",
  reason: "test cut reason here",
  confidence: 0.9,
});

// ---- normalisation -------------------------------------------------------

test("normalizeCuts sorts by start", () => {
  const out = normalizeCuts([cut("c2", 0, 4, 5), cut("c1", 0, 1, 2)], FPS);
  assert.equal(out[0].startTicks, T(1));
  assert.equal(out[1].startTicks, T(4));
});

test("normalizeCuts merges overlapping cuts", () => {
  const out = normalizeCuts([cut("c1", 0, 1, 3), cut("c2", 0, 2, 5)], FPS);
  assert.equal(out.length, 1);
  assert.equal(out[0].startTicks, T(1));
  assert.equal(out[0].endTicks, T(5));
});

test("normalizeCuts merges touching cuts", () => {
  const out = normalizeCuts([cut("c1", 0, 1, 2), cut("c2", 0, 2, 3)], FPS);
  assert.equal(out.length, 1);
  assert.equal(out[0].endTicks, T(3));
});

test("normalizeCuts drops empty cuts", () => {
  const out = normalizeCuts([cut("c1", 0, 2, 2)], FPS);
  assert.equal(out.length, 0);
});

// ---- keep-list inversion -------------------------------------------------

test("keptRanges inverts a middle cut into two keeps", () => {
  const keeps = keptRanges([{ startTicks: T(1), endTicks: T(2) }], T(6));
  assert.equal(keeps.length, 2);
  assert.deepEqual(keeps[0], { startTicks: 0n, endTicks: T(1) });
  assert.deepEqual(keeps[1], { startTicks: T(2), endTicks: T(6) });
});

test("keptRanges returns one keep when the cut is at the very start", () => {
  const keeps = keptRanges([{ startTicks: 0n, endTicks: T(1) }], T(6));
  assert.equal(keeps.length, 1);
  assert.deepEqual(keeps[0], { startTicks: T(1), endTicks: T(6) });
});

test("keptRanges returns nothing when the whole clip is cut", () => {
  const keeps = keptRanges([{ startTicks: 0n, endTicks: T(6) }], T(6));
  assert.equal(keeps.length, 0);
});

// ---- place-op compilation -----------------------------------------------

test("compilePlaceOps lays kept ranges back to back", () => {
  const keeps = [
    { startTicks: 0n, endTicks: T(1) },
    { startTicks: T(2), endTicks: T(6) },
  ];
  const { ops, totalTicks } = compilePlaceOps({ sourceIndex: 0, keeps, fps: FPS });

  assert.equal(ops.length, 2);
  assert.equal(ops[0].startTicks, "0");
  assert.equal(ops[0].sourceInTicks, "0");
  assert.equal(ops[0].durationTicks, T(1).toString());

  assert.equal(ops[1].startTicks, T(1).toString(), "second clip starts where the first ended");
  assert.equal(ops[1].sourceInTicks, T(2).toString());
  assert.equal(ops[1].durationTicks, T(4).toString());

  assert.equal(totalTicks, T(5));
});

test("compilePlaceOps skips sub-frame ranges", () => {
  const keeps = [{ startTicks: 0n, endTicks: 1n }]; // 1 tick, far below a frame
  const { ops } = compilePlaceOps({ sourceIndex: 0, keeps, fps: FPS });
  assert.equal(ops.length, 0);
});

// ---- whole-plan compilation ---------------------------------------------

test("compilePlan produces the expected op sequence", () => {
  const p = plan([cut("c1", 0, 1, 2), cut("c2", 1, 1, 2)]);
  const compiled = compilePlan(p, media);

  const kinds = compiled.ops.map((o) => o.op);
  assert.equal(kinds[0], "newProject");
  assert.equal(kinds[1], "newSequence");
  assert.equal(kinds[2], "importMedia");
  assert.equal(kinds.filter((k) => k === "place").length, 4); // 2 keeps per source
  assert.equal(ticksToSeconds(compiled.expectedDurationTicks), 10); // 5 + 5
});

test("compilePlan is deterministic", () => {
  const p = plan([cut("c1", 0, 1, 2), cut("c2", 1, 1, 2)]);
  const a = compilePlan(p, media);
  const b = compilePlan(p, media);
  assert.deepEqual(a, b);
});

test("compilePlan offsets the second source after the first", () => {
  const p = plan([cut("c1", 0, 1, 2)]);
  const compiled = compilePlan(p, media);
  const places = compiled.ops.filter((o) => o.op === "place");
  // source 0: two keeps (0-1s, 2-6s) = 5s, then source 1: one keep (0-6s) starting at 5s
  const src1 = places.filter((pl) => pl.sourceIndex === 1);
  assert.equal(src1.length, 1);
  assert.equal(src1[0].startTicks, T(5).toString());
});

test("compilePlan emits caption and marker ops", () => {
  const p = {
    ...plan([]),
    subtitles: [{ startTicks: "0", endTicks: T(2).toString(), text: "Halo", language: "id" }],
    chapters: [{ startTicks: "0", title: "Intro" }],
  };
  const compiled = compilePlan(p, media);
  assert.equal(compiled.ops.filter((o) => o.op === "caption").length, 1);
  assert.equal(compiled.ops.filter((o) => o.op === "marker").length, 1);
  assert.equal(compiled.ops.filter((o) => o.op === "captionTrack").length, 1);
});

// ---- validation ---------------------------------------------------------

test("validatePlan accepts a good plan", () => {
  const r = validatePlan(plan([cut("c1", 0, 1, 2)]), media);
  assert.equal(r.ok, true);
});

test("validatePlan rejects a cut beyond the source", () => {
  assert.throws(
    () => validatePlan(plan([cut("c1", 0, 1, 99)]), media),
    (e) => e.diagnostics.some((d) => d.layer === "reality")
  );
});

test("validatePlan rejects an unknown sourceIndex", () => {
  assert.throws(
    () => validatePlan(plan([cut("c1", 7, 1, 2)]), media),
    (e) => e.diagnostics.some((d) => d.path.includes("sourceIndex"))
  );
});

test("validatePlan rejects a cut with start >= end", () => {
  const bad = cut("c1", 0, 3, 2);
  assert.throws(() => validatePlan(plan([bad]), media), (e) =>
    e.diagnostics.some((d) => d.msg.includes("start"))
  );
});

test("validatePlan rejects removing more than 60% of the footage", () => {
  assert.throws(
    () => validatePlan(plan([cut("c1", 0, 0, 6), cut("c2", 1, 0, 5)]), media),
    (e) => e.diagnostics.some((d) => d.msg.includes("refusing"))
  );
});

test("validatePlan rejects a too-short cut", () => {
  // 50 ms is below the 120 ms floor
  const c = { ...cut("c1", 0, 1, 1.05) };
  assert.throws(
    () => validatePlan(plan([c]), media),
    (e) => e.diagnostics.some((d) => d.layer === "sanity")
  );
});

test("validatePlan rejects a schema-invalid reason", () => {
  const c = { ...cut("c1", 0, 1, 2), reason: "short" };
  assert.throws(
    () => validatePlan(plan([c]), media),
    (e) => e.diagnostics.some((d) => d.layer === "schema" && d.path.includes("reason"))
  );
});

test("validatePlan rejects a bad confidence", () => {
  const c = { ...cut("c1", 0, 1, 2), confidence: 5 };
  assert.throws(
    () => validatePlan(plan([c]), media),
    (e) => e.diagnostics.some((d) => d.path.includes("confidence"))
  );
});

test("validatePlan rejects a non-1080p sequence", () => {
  const p = { ...plan([]), sequence: { ...plan([]).sequence, width: 1280 } };
  assert.throws(() => validatePlan(p, media), (e) =>
    e.diagnostics.some((d) => d.path === "sequence.width")
  );
});

test("checkReality reports the exact overrun", () => {
  const d = checkReality(plan([cut("c1", 0, 1, 99)]), media);
  assert.ok(d.length > 0);
  assert.match(d[0].msg, /only .* ticks long/);
});
