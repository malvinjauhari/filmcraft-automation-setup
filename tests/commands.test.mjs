import test from "node:test";
import assert from "node:assert/strict";

import * as cmd from "../services/editing-orchestrator/src/filmcraft/commands.mjs";

/**
 * These are the regression tests for the FilmCraft traps. Each golden snapshot
 * pins the exact param shape, so a rename of `seconds` to `time.seconds` (which
 * FilmCraft silently accepts and then places at 0) fails here instead of
 * corrupting a timeline.
 */

test("placeClip puts seconds as a SIBLING of track, never inside time", () => {
  const c = cmd.placeClip({ item: 8, track: "V1", startSeconds: 6, audioTrack: "A1" });

  assert.equal(c.id, "timeline.place");
  assert.deepEqual(c.params, {
    item: 8,
    track: "V1",
    seconds: 6,
    audioTrack: "A1",
  });

  // The trap: this must never appear.
  assert.equal(c.params.time, undefined);
  assert.equal(c.params.seconds, 6);
});

test("placeClip encodes sourceIn and duration as {seconds} objects", () => {
  const c = cmd.placeClip({
    item: 8,
    track: "V1",
    startSeconds: 0,
    sourceInSeconds: 1.5,
    durationSeconds: 4,
  });
  assert.deepEqual(c.params.sourceIn, { seconds: 1.5 });
  assert.deepEqual(c.params.duration, { seconds: 4 });
});

test("placeClip rejects a non-integer item id", () => {
  assert.throws(() => cmd.placeClip({ item: "8", track: "V1", startSeconds: 0 }), TypeError);
});

test("placeClip rejects a malformed track", () => {
  assert.throws(() => cmd.placeClip({ item: 1, track: "Video 1", startSeconds: 0 }), TypeError);
});

test("newSequence refuses a non-numeric fps", () => {
  // FilmCraft silently falls back to 23.976 for fps:"fast".
  assert.throws(() => cmd.newSequence({ name: "x", fps: "fast" }), RangeError);
});

test("importMedia requires absolute paths", () => {
  assert.throws(() => cmd.importMedia(["relative.mp4"]), TypeError);
  assert.doesNotThrow(() => cmd.importMedia(["/abs/a.mp4"]));
});

test("exportMedia refuses a directory path", () => {
  // FilmCraft hangs indefinitely on a directory.
  assert.throws(() => cmd.exportMedia({ path: "/tmp/out/", preset: "x" }), TypeError);
});

test("exportMedia refuses a relative path", () => {
  assert.throws(() => cmd.exportMedia({ path: "out.mp4" }), TypeError);
});

test("exportMedia does not invent a preset", () => {
  const c = cmd.exportMedia({ path: "/tmp/out.mp4" });
  assert.equal(c.params.preset, undefined);
  assert.equal(c.params.wait, true);
});

test("trim uses delta, not seconds", () => {
  const c = cmd.trim({ clip: 5, edge: "out", deltaTicks: 254016000n });
  assert.equal(c.id, "timeline.trim");
  assert.equal(c.params.delta, "254016000");
  assert.equal(c.params.seconds, undefined);
  assert.equal(c.params.edge, "out");
});

test("addCaption sends seconds and durationSeconds as numbers", () => {
  const c = cmd.addCaption({ text: "Halo", startSeconds: 0.5, durationSeconds: 2.5 });
  assert.equal(c.id, "captions.add");
  assert.equal(typeof c.params.seconds, "number");
  assert.equal(typeof c.params.durationSeconds, "number");
});

test("newCaptionTrack forces the Subtitle format", () => {
  const c = cmd.newCaptionTrack({ name: "ID", language: "id" });
  assert.equal(c.params.format, "Subtitle");
});

test("addMarker sends ticks as a string", () => {
  const c = cmd.addMarker({ seconds: 2, name: "Intro" });
  assert.equal(c.params.time, "508032000000");
  assert.equal(c.params.name, "Intro");
});

test("every builder returns a {id, params} pair", () => {
  const builders = [
    cmd.newProject("p"),
    cmd.newSequence({ name: "s" }),
    cmd.importMedia(["/a.mp4"]),
    cmd.placeClip({ item: 1, track: "V1", startSeconds: 0 }),
    cmd.razor({ seconds: 1, track: "V1" }),
    cmd.rippleDelete([1]),
    cmd.trim({ clip: 1, edge: "in", deltaTicks: 1n }),
    cmd.audioGain({ clips: [1], db: 2 }),
    cmd.newCaptionTrack({}),
    cmd.addCaption({ text: "a", startSeconds: 0, durationSeconds: 1 }),
    cmd.addMarker({ seconds: 0, name: "m" }),
    cmd.saveAs("/tmp/p.fcproj"),
    cmd.exportMedia({ path: "/tmp/o.mp4" }),
    cmd.exportCaptions({ path: "/tmp/o.srt" }),
    cmd.renderFrame({ path: "/tmp/f.png", seconds: 1 }),
    cmd.exportInterchange({ path: "/tmp/o.xml" }),
  ];
  for (const b of builders) {
    assert.equal(typeof b.id, "string", `id missing on ${JSON.stringify(b)}`);
    assert.equal(typeof b.params, "object");
    assert.ok(b.id.includes("."), `command id should be namespaced: ${b.id}`);
  }
});
