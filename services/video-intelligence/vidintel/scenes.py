"""Shot detection with PySceneDetect.

Used two ways:
  - avoid cutting across a visual change (jarring mid-scroll)
  - seed chapter markers

ContentDetector at 27.0 is a reasonable default for screen recordings: lower
misses subtle scroll transitions, higher fires on every terminal line repaint.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .timeutil import to_ticks

DEFAULT_THRESHOLD = 27.0

# Container/codec suffixes with no video stream. Scene detection on these can
# only fail, so skip them instead of warning on every audio file in a job.
AUDIO_ONLY_SUFFIXES = {
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif",
}


def detect_scenes(
    path: str | Path,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_scene_seconds: float = 0.5,
    log=None,
) -> list[dict[str, Any]]:
    """Return [{index, startTicks, endTicks, startSeconds, endSeconds, score}]."""
    from scenedetect import ContentDetector, SceneManager, open_video

    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"scene detection: no such file {p}")

    # Audio-only files have no frames to compare. Skip quietly rather than
    # emitting a decode warning on every mp3 in the job.
    if p.suffix.lower() in AUDIO_ONLY_SUFFIXES:
        if log:
            log.info("scene detection skipped (audio-only)", name=p.name)
        return []

    try:
        video = open_video(str(p))
        sm = SceneManager()
        sm.add_detector(ContentDetector(threshold=threshold))
        sm.detect_scenes(video, show_progress=False)
        scene_list = sm.get_scene_list()
    except TypeError as e:
        # scenedetect 0.7 changed open_video's signature; fall back to the
        # explicit frame-rate form rather than failing the whole analysis.
        if log:
            log.warn("scene detect signature mismatch, retrying", error=str(e))
        try:
            video = open_video(str(p), backend="opencv")
            sm = SceneManager()
            sm.add_detector(ContentDetector(threshold=threshold))
            sm.detect_scenes(video, show_progress=False)
            scene_list = sm.get_scene_list()
        except Exception as e2:
            if log:
                log.warn("scene detection failed; continuing without it", error=str(e2))
            return []
    except Exception as e:  # decoding can fail on exotic codecs
        if log:
            log.warn("scene detection failed; continuing without it", error=str(e))
        return []

    out = []
    for i, (start, end) in enumerate(scene_list):
        s = start.get_seconds()
        e = end.get_seconds()
        if e - s < min_scene_seconds:
            continue
        out.append(
            {
                "index": len(out),
                "startSeconds": round(s, 4),
                "endSeconds": round(e, 4),
                "startTicks": str(to_ticks(s)),
                "endTicks": str(to_ticks(e)),
            }
        )

    if log:
        log.info("scenes detected", count=len(out))
    return out
