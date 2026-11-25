import test from "node:test";
import assert from "node:assert/strict";

import { secondsToTicks } from "../services/editing-orchestrator/src/timeline/time.mjs";
import {
  buildSubtitleCues,
  formatSrt,
  wrapSubtitleLines,
} from "../services/editing-orchestrator/src/subtitles/srt.mjs";
import { proposePlan } from "../services/editing-orchestrator/src/plan/propose.mjs";
import { validatePlan } from "../services/editing-orchestrator/src/plan/validate.mjs";
import { compilePlan } from "../services/editing-orchestrator/src/plan/compile.mjs";
import { parseLoudnormJson } from "../services/editing-orchestrator/src/audio/loudness.mjs";
import { FilmCraftClient } from "../services/editing-orchestrator/src/filmcraft/client.mjs";
import {
  buildReport,
  formatReportMarkdown,
} from "../services/editing-orchestrator/src/report/write.mjs";

const T = (sec) => secondsToTicks(sec).toString();

test("wrapSubtitleLines respects maxCharsPerLine and maxLines", () => {
  const text = "Ini adalah contoh kalimat bahasa Indonesia yang cukup panjang untuk dua baris";
  const wrapped = wrapSubtitleLines(text, 42, 2);
  const lines = wrapped.split("\n");
  assert.ok(lines.length <= 2);
  for (const line of lines) {
    assert.ok(line.length <= 42, `line too long: ${line.length}`);
  }
});

test("buildSubtitleCues remaps timestamps across cuts and formats SRT", () => {
  const mediaSources = [{ index: 0, durationTicks: T(10) }];
  // Cut [2s, 4s) -> 2s..4s removed, so word at 5s..6s shifts to 3s..4s
  const cuts = [{ sourceIndex: 0, startTicks: T(2), endTicks: T(4) }];
  const transcriptsBySource = {
    0: {
      words: [
        { text: "Halo", startTicks: T(0.5), endTicks: T(1.0) },
        { text: "emm", startTicks: T(2.5), endTicks: T(3.0) }, // inside cut
        { text: "semuanya.", startTicks: T(5.0), endTicks: T(6.0) },
      ],
    },
  };

  const cues = buildSubtitleCues({
    transcriptsBySource,
    cuts,
    mediaSources,
    fps: 30,
    options: { minCueSeconds: 0.5 },
  });

  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Halo");
  assert.equal(cues[1].text, "semuanya.");
  assert.equal(cues[1].startTicks, T(3));

  const srt = formatSrt(cues);
  assert.match(srt, /^1\n00:00:00,500 --> 00:00:01,000\nHalo\n\n2\n00:00:03,000 --> 00:00:04,000\nsemuanya\./);
});

test("proposePlan produces a schema/reality/sanity valid plan", () => {
  const media = {
    version: "1.0",
    jobId: "test-job",
    sources: [
      {
        index: 0,
        path: "/tmp/a.mp4",
        durationTicks: T(20),
        video: { width: 1920, height: 1080, fps: 30 },
        audio: { sampleRate: 48000, channels: 2 },
      },
    ],
  };

  const analysis = {
    sources: [
      {
        sourceIndex: 0,
        candidates: [
          {
            id: "cand-1",
            startTicks: T(2),
            endTicks: T(3.5),
            kind: "silence",
            reason: "Long silence > 1.5s",
            confidence: 0.9,
          },
          {
            id: "cand-low",
            startTicks: T(5),
            endTicks: T(6),
            kind: "filler",
            reason: "Low confidence filler",
            confidence: 0.3,
          },
        ],
        scenes: [{ startTicks: T(0) }, { startTicks: T(10) }],
      },
    ],
  };

  const transcriptsBySource = {
    0: {
      words: [
        { text: "Selamat", startTicks: T(0.2), endTicks: T(0.6) },
        { text: "datang.", startTicks: T(0.7), endTicks: T(1.2) },
      ],
    },
  };

  const plan = proposePlan({
    jobId: "test-job",
    media,
    transcriptsBySource,
    analysis,
    preset: {
      name: "tutorial-id",
      pacing: { minCutSeconds: 0.18, maxRemovalRatioPerWindow: 0.35 },
      subtitles: { enabled: true, burnIn: true, language: "id" },
      audio: { targetLufs: -14 },
      export: { fps: 30 },
    },
  });

  assert.equal(plan.cuts.length, 1);
  assert.equal(plan.cuts[0].id, "c1");
  assert.equal(plan.cuts[0].candidateId, "cand-1");
  assert.doesNotThrow(() => validatePlan(plan, media));
});

test("parseLoudnormJson extracts input_i and input_tp", () => {
  const sampleStderr = `
[Parsed_loudnorm_0 @ 0x123] {
  "input_i" : "-18.42",
  "input_tp" : "-2.10",
  "input_lra" : "4.50",
  "input_thresh" : "-28.90"
}
`;
  const parsed = parseLoudnormJson(sampleStderr);
  assert.deepEqual(parsed, { inputLufs: -18.42, truePeakDb: -2.1, lra: 4.5 });
});

test("buildReport and formatReportMarkdown summarize cuts and savings", () => {
  const media = { sources: [{ index: 0, durationTicks: T(10) }] };
  const plan = {
    version: "1.0",
    jobId: "rep-1",
    sequence: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    cuts: [
      {
        id: "c1",
        sourceIndex: 0,
        startTicks: T(2),
        endTicks: T(4),
        kind: "silence",
        reason: "Dead air pause",
        confidence: 0.92,
      },
    ],
    subtitles: [],
  };
  const compiled = compilePlan(plan, media);
  const report = buildReport({
    jobId: "rep-1",
    presetName: "tutorial-id",
    media,
    plan,
    compiled,
  });

  assert.equal(report.summary.originalDurationSeconds, 10);
  assert.equal(report.summary.finalDurationSeconds, 8);
  assert.equal(report.summary.savedPercent, 20);
  const md = formatReportMarkdown(report);
  assert.match(md, /# Editing Report — rep-1/);
  assert.match(md, /Dead air pause/);
});

test("FilmCraftClient builds headless and bridge mcpArgs", () => {
  const headless = new FilmCraftClient({ dataDir: "/tmp/fc", project: "/tmp/p.fcproj" });
  assert.deepEqual(headless.mcpArgs(), ["mcp", "--data-dir", "/tmp/fc", "--project", "/tmp/p.fcproj"]);

  const bridged = new FilmCraftClient({ bridge: "127.0.0.1:7991", controlToken: "a".repeat(64) });
  assert.deepEqual(bridged.mcpArgs(), ["mcp", "--bridge", "127.0.0.1:7991"]);
});

test("FilmCraftClient bridge mode requires 64-char hex FILMCRAFT_CONTROL_TOKEN", async () => {
  const noToken = new FilmCraftClient({ bridge: "127.0.0.1:7991", controlToken: "" });
  await assert.rejects(() => noToken.start(), /FILMCRAFT_CONTROL_TOKEN/);

  const badToken = new FilmCraftClient({ bridge: "127.0.0.1:7991", controlToken: "short" });
  await assert.rejects(() => badToken.start(), /FILMCRAFT_CONTROL_TOKEN/);
});

test("compilePlan omits caption ops when includeCaptions is false", () => {
  const media = { sources: [{ index: 0, path: "/tmp/a.mp4", durationTicks: T(10) }] };
  const plan = {
    version: "1.0",
    jobId: "nocap",
    sequence: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    cuts: [],
    subtitles: [{ startTicks: T(0), endTicks: T(2), text: "Halo", language: "id" }],
  };
  const compiled = compilePlan(plan, media, { includeCaptions: false });
  assert.equal(compiled.ops.some((o) => o.op === "captionTrack" || o.op === "caption"), false);
});
