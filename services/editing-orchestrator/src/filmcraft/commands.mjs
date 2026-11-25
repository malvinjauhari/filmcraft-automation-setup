/**
 * Typed command builders.
 *
 * THIS IS THE ONLY FILE THAT MAY CONTAIN A FILMCRAFT COMMAND ID LITERAL.
 *
 * Every builder is unit-tested against a golden params snapshot. A typo in a
 * key name fails a test instead of silently placing a clip at zero.
 *
 * The traps this file encodes, verified on FilmCraft 0.17.1:
 *   - timeline.place: `seconds` is a SIBLING of `track`, never nested in `time`.
 *   - sourceIn / duration accept `{seconds}` objects but NOT nested under `time`.
 *   - file.saveAs does not create parent directories.
 *   - file.exportMedia hangs forever on a directory path.
 *   - preset names are not stable; query export.presets.list.
 */

import { secondsToTicks, ticksToSeconds } from "../timeline/time.mjs";

const assertPath = (p, what) => {
  if (typeof p !== "string" || !p.trim()) throw new TypeError(`${what}: need a path`);
  if (!p.startsWith("/")) throw new TypeError(`${what}: must be absolute, got ${p}`);
  return p;
};

/** New project. `file.newProject` takes only a name. */
export function newProject(name) {
  if (!name?.trim()) throw new TypeError("newProject: need a name");
  return { id: "file.newProject", params: { name } };
}

/** New sequence. `fps` must be a number; "fast" silently becomes 23.976. */
export function newSequence({ name, width = 1920, height = 1080, fps = 30, sampleRate = 48000 }) {
  if (!(fps > 0)) throw new RangeError(`newSequence: fps must be > 0, got ${fps}`);
  return {
    id: "file.newSequence",
    params: { name, width, height, fps, sampleRate },
  };
}

/**
 * Import media by absolute path. Returns {items:[id…]} which callers MUST map
 * back to source indices — item ids are not stable across runs.
 */
export function importMedia(paths, bin) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TypeError("importMedia: need at least one path");
  }
  paths.forEach((p) => assertPath(p, "importMedia"));
  return { id: "file.import", params: { paths, ...(bin ? { bin } : {}) } };
}

/**
 * Place a clip at a timeline position, optionally trimming from the source.
 *
 * @param {object} o
 * @param {number} o.item          FilmCraft item id
 * @param {string} o.track         "V1"
 * @param {number} o.startSeconds  output position  <-- sibling of track
 * @param {string} [o.audioTrack]  "A1" (omit for video-only)
 * @param {number} [o.sourceInSeconds]
 * @param {number} [o.durationSeconds]
 */
export function placeClip({ item, track, startSeconds, audioTrack, sourceInSeconds, durationSeconds }) {
  if (!Number.isInteger(item)) throw new TypeError(`placeClip: item must be an integer, got ${item}`);
  if (!/^(V|A)\d+$/.test(track)) throw new TypeError(`placeClip: bad track ${track}`);
  if (typeof startSeconds !== "number" || startSeconds < 0) {
    throw new TypeError(`placeClip: startSeconds must be a number >= 0`);
  }

  const params = { item, track, seconds: startSeconds };
  if (audioTrack) params.audioTrack = audioTrack;

  // FilmCraft accepts {"seconds":N} objects for these two, but NOT nested
  // under `time`. Keep them as objects so the frame grid is respected.
  if (sourceInSeconds !== undefined) {
    if (sourceInSeconds < 0) throw new RangeError("placeClip: negative sourceIn");
    params.sourceIn = { seconds: sourceInSeconds };
  }
  if (durationSeconds !== undefined) {
    if (durationSeconds <= 0) throw new RangeError("placeClip: duration must be > 0");
    params.duration = { seconds: durationSeconds };
  }
  return { id: "timeline.place", params };
}

/** Cut at an exact time. Prefer placing kept ranges over razor+delete. */
export function razor({ seconds, track, clip }) {
  const params = { time: secondsToTicks(seconds).toString() };
  if (track) params.track = track;
  if (clip) params.clip = clip;
  return { id: "timeline.razor", params };
}

/** Delete clips and close the gap. */
export function rippleDelete(clips) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new TypeError("rippleDelete: need clip ids");
  }
  return { id: "edit.rippleDelete", params: { clips } };
}

/** Trim an edge by a tick delta. The key is `delta`, not `seconds`. */
export function trim({ clip, edge, deltaTicks, ripple = false }) {
  if (edge !== "in" && edge !== "out") throw new TypeError(`trim: edge must be in|out`);
  return {
    id: "timeline.trim",
    params: {
      clip,
      edge,
      mode: ripple ? "ripple" : "regular",
      delta: BigInt(deltaTicks).toString(),
    },
  };
}

/** Audio gain on clips. */
export function audioGain({ clips, db, mode = "adjust" }) {
  if (!Array.isArray(clips) || clips.length === 0) throw new TypeError("audioGain: need clips");
  if (typeof db !== "number") throw new TypeError("audioGain: db must be a number");
  return { id: "clip.audioGain", params: { clips, mode, db } };
}

/** Caption track. Unknown format strings silently fall back to Subtitle. */
export function newCaptionTrack({ name = "Subtitles", language = "id" }) {
  return {
    id: "captions.newTrack",
    params: { format: "Subtitle", name, language },
  };
}

/** One caption cue. */
export function addCaption({ text, startSeconds, durationSeconds, track }) {
  if (!text?.trim()) throw new TypeError("addCaption: need text");
  if (!(durationSeconds > 0)) throw new RangeError("addCaption: duration must be > 0");
  return {
    id: "captions.add",
    params: {
      text,
      seconds: startSeconds,
      durationSeconds,
      ...(track ? { track } : {}),
    },
  };
}

/** Write the caption track to an SRT/VTT file. */
export function exportCaptions({ path, format = "srt", track }) {
  assertPath(path, "exportCaptions");
  return {
    id: "captions.export",
    params: { path, format, ...(track ? { track } : {}) },
  };
}

/** Sequence marker (chapter). */
export function addMarker({ seconds, name }) {
  if (!name?.trim()) throw new TypeError("addMarker: need a name");
  return {
    id: "markers.add",
    params: { time: secondsToTicks(seconds).toString(), name },
  };
}

/** Save project. The parent directory must already exist. */
export function saveAs(path) {
  assertPath(path, "saveAs");
  return { id: "file.saveAs", params: { path } };
}

/**
 * Export. `path` must be a FILE, never a directory (a directory hangs forever).
 * `preset` must come from export.presets.list — never hardcoded.
 */
export function exportMedia({
  path,
  preset,
  format,
  burnCaptions = false,
  captionSidecar,
  range = "entire",
  wait = true,
}) {
  assertPath(path, "exportMedia");
  if (path.endsWith("/")) {
    throw new TypeError("exportMedia: path must be a file, not a directory");
  }
  const params = { path, range, wait };
  if (preset) params.preset = preset;
  if (format) params.format = format;
  if (burnCaptions) params.burnCaptions = true;
  if (captionSidecar) params.captionSidecar = captionSidecar;
  return { id: "file.exportMedia", params };
}

/** Render a single frame to PNG, for QC spot checks. */
export function renderFrame({ path, seconds, maxSide }) {
  assertPath(path, "renderFrame");
  return {
    id: "file.exportFrame",
    params: {
      path,
      format: "png",
      target: "program",
      time: secondsToTicks(seconds).toString(),
      ...(maxSide ? { maxSide } : {}),
    },
  };
}

/** Interchange export so the edit opens in Premiere/Resolve. */
export function exportInterchange({ path, format = "fcpxml" }) {
  assertPath(path, "exportInterchange");
  return { id: "file.exportInterchange", params: { format, path } };
}

export { ticksToSeconds };
