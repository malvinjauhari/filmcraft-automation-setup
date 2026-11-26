import test from "node:test";
import assert from "node:assert/strict";

import { isUrl, parseLibregetInfo, downloadMedia } from "./libreget.mjs";

test("isUrl detects http and https URLs", () => {
  assert.equal(isUrl("https://www.youtube.com/watch?v=abc123"), true);
  assert.equal(isUrl("http://example.com/video.mp4"), true);
  assert.equal(isUrl("raw-video/video.mp4"), false);
  assert.equal(isUrl("/home/user/video.mp4"), false);
});

test("parseLibregetInfo parses JSON and text metadata", () => {
  const jsonOut = parseLibregetInfo(
    JSON.stringify({ title: "Tutorial Node", duration: 120, chapters: [{ title: "Intro" }] })
  );
  assert.equal(jsonOut.title, "Tutorial Node");
  assert.equal(jsonOut.chapters.length, 1);

  const textOut = parseLibregetInfo("Title: Belajar FilmCraft\n00:00 Intro\n01:15 Cutting");
  assert.equal(textOut.title, "Belajar FilmCraft");
  assert.equal(textOut.chapters.length, 2);
});

test("downloadMedia dryRun returns simulated download path and command", async () => {
  const res = await downloadMedia("https://www.youtube.com/watch?v=test", {
    rootDir: process.cwd(),
    quality: 1080,
    dryRun: true,
  });
  assert.equal(res.dryRun, true);
  assert.match(res.command, /libreget download .* -q 1080/);
  assert.match(res.filePath, /dry-run-download\.mp4$/);
});
