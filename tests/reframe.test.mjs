import test from "node:test";
import assert from "node:assert/strict";

import { buildReframeFilter, reframeVideo } from "../services/editing-orchestrator/src/video/reframe.mjs";
import { formatAss } from "../services/editing-orchestrator/src/subtitles/srt.mjs";
import { validatePlan } from "../services/editing-orchestrator/src/plan/validate.mjs";

test("buildReframeFilter generates blur and crop filters for portrait and landscape", () => {
  const blurPortrait = buildReframeFilter({ width: 1080, height: 1920, mode: "blur" });
  assert.match(blurPortrait, /1080:1920/);
  assert.match(blurPortrait, /boxblur/);

  const cropLandscape = buildReframeFilter({ width: 1920, height: 1080, mode: "crop" });
  assert.match(cropLandscape, /crop=1920:1080/);
});

test("reframeVideo dryRun returns ffmpeg command without running", async () => {
  const res = await reframeVideo("in.mp4", "out.mp4", {
    width: 1080,
    height: 1920,
    mode: "blur",
    dryRun: true,
  });
  assert.equal(res.dryRun, true);
  assert.match(res.command, /ffmpeg .*1080:1920.*out\.mp4/);
});

test("formatAss generates styled ASS subtitles with custom font and PlayRes", () => {
  const ass = formatAss(
    [{ startTicks: "0", endTicks: "254016000000", text: "Halo dunia" }],
    { font: "Noto Sans", size: 58, color: "#FFE600", bold: true, marginV: 220 },
    { width: 1080, height: 1920 }
  );
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Default,Noto Sans,58,&H0000E6FF/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.00,Default,,0,0,0,,Halo dunia/);
});

test("validatePlan accepts 1080x1920 portrait sequence", () => {
  const media = {
    version: "1.0",
    jobId: "j1",
    sources: [{ index: 0, durationTicks: "2540160000000", path: "/tmp/a.mp4", sha256: "a".repeat(64) }],
  };
  const plan = {
    version: "1.0",
    jobId: "j1",
    sequence: { width: 1080, height: 1920, fps: 30, sampleRate: 48000 },
    cuts: [],
    subtitles: [],
  };
  assert.equal(validatePlan(plan, media).ok, true);
});
