import test from "node:test";
import assert from "node:assert/strict";

import {
  TICKS_PER_SECOND,
  secondsToTicks,
  ticksToSeconds,
  ticksPerFrame,
  snapToFrame,
  floorToFrame,
  ticksToFrame,
  frameToTicks,
  formatSrtTime,
} from "../services/editing-orchestrator/src/timeline/time.mjs";

test("TICKS_PER_SECOND is the FilmCraft constant", () => {
  assert.equal(TICKS_PER_SECOND, 254_016_000_000n);
  // 48000 * 5292 is 254_016_000 — a factor of 1000 short. The real
  // factorization is 48000 * 5_292_000. (The upstream skill doc states
  // "48000x5292", which is wrong by three orders of magnitude.)
  assert.equal(TICKS_PER_SECOND, 48000n * 5_292_000n);
  assert.notEqual(TICKS_PER_SECOND, 48000n * 5292n);
});

test("secondsToTicks converts exactly at integer seconds", () => {
  assert.equal(secondsToTicks(0), 0n);
  assert.equal(secondsToTicks(1), 254_016_000_000n);
  assert.equal(secondsToTicks(6), 1_524_096_000_000n);
});

test("secondsToTicks rejects bad input instead of silently coercing", () => {
  assert.throws(() => secondsToTicks("6"), TypeError);
  assert.throws(() => secondsToTicks(NaN), TypeError);
  assert.throws(() => secondsToTicks(-1), RangeError);
});

test("ticksToSeconds round-trips", () => {
  for (const s of [0, 0.5, 1, 6, 12.345, 3600]) {
    assert.ok(Math.abs(ticksToSeconds(secondsToTicks(s)) - s) < 1e-9, `round trip ${s}`);
  }
});

test("ticksPerFrame is exact at 30fps", () => {
  // 254016000000 / 30 = 8467200000 exactly
  assert.equal(ticksPerFrame(30), 8_467_200_000n);
});

test("frame 180 at 30fps is exactly 6 seconds", () => {
  const t = frameToTicks(180, 30);
  assert.equal(t, 1_524_096_000_000n);
  assert.equal(ticksToSeconds(t), 6);
});

test("snapToFrame lands on the frame grid", () => {
  const f = ticksPerFrame(30);
  const off = 1_524_096_000_000n + f / 3n;
  const snapped = snapToFrame(off, 30);
  assert.equal(snapped % f, 0n);
  assert.ok(snapped === 1_524_096_000_000n || snapped === 1_524_096_000_000n + f);
});

test("floorToFrame never advances past the input", () => {
  const f = ticksPerFrame(30);
  const off = 1_524_096_000_000n + f / 2n;
  const floored = floorToFrame(off, 30);
  assert.equal(floored, 1_524_096_000_000n);
  assert.ok(floored <= off);
});

test("ticksToFrame is the inverse of frameToTicks", () => {
  for (const fr of [0, 1, 30, 180, 1800]) {
    assert.equal(ticksToFrame(frameToTicks(fr, 30), 30), fr);
  }
});

test("bigint arithmetic does not lose precision on long timelines", () => {
  // 2 hours = 1.83e15 ticks, comfortably inside 2^53.
  const twoHours = secondsToTicks(7200);
  assert.equal(twoHours, 1_828_915_200_000_000n);
  assert.ok(twoHours < BigInt(Number.MAX_SAFE_INTEGER));

  // 10 hours = 9.14e15 ticks, which EXCEEDS 2^53 (9.007e15). This is why
  // tick math must be BigInt and never Number.
  const tenHours = secondsToTicks(36000);
  assert.equal(tenHours, 9_144_576_000_000_000n);
  assert.ok(tenHours > BigInt(Number.MAX_SAFE_INTEGER));

  // The precision loss Number would suffer:
  assert.notEqual(Number(tenHours), Number(tenHours) + 2);
  // BigInt keeps them distinct:
  assert.notEqual(tenHours, tenHours + 2n);
});

test("formatSrtTime uses a comma and zero-pads", () => {
  assert.equal(formatSrtTime(0n), "00:00:00,000");
  assert.equal(formatSrtTime(secondsToTicks(1.5)), "00:00:01,500");
  assert.equal(formatSrtTime(secondsToTicks(3661.25)), "01:01:01,250");
});
