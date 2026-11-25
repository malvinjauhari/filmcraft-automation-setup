"""Silence and filler analysis, and the rule-based cut candidates built from them.

The guards here are the difference between a usable first cut and a butchered
one. They are not cosmetic: each one encodes a real failure mode.

  1. snap to word edges   - a cut mid-word sounds like a glitch
  2. max 35% per 30s      - more means the detector is wrong, not the speaker
  3. protect take edges   - never cut the first/last 300 ms
  4. flag scene crossings - cutting across a visual change is jarring
"""

from __future__ import annotations

from typing import Any

from .timeutil import to_seconds, to_ticks

MIN_CUT_SECONDS = 0.18
MAX_REMOVAL_RATIO_PER_WINDOW = 0.35
WINDOW_SECONDS = 30.0
EDGE_PROTECT_SECONDS = 0.3


def find_silences(
    speech_spans: list[dict[str, Any]],
    duration_seconds: float,
    *,
    min_silence_seconds: float = 0.5,
) -> list[dict[str, Any]]:
    """Gaps between speech spans, longer than the threshold, classified."""
    if duration_seconds <= 0:
        return []

    silences: list[dict[str, Any]] = []
    spans = sorted(speech_spans, key=lambda s: s["startSeconds"])

    cursor = 0.0
    for i, s in enumerate(spans):
        if s["startSeconds"] - cursor >= min_silence_seconds:
            silences.append(
                _silence(cursor, s["startSeconds"], "leading" if i == 0 else "internal")
            )
        cursor = max(cursor, s["endSeconds"])

    if duration_seconds - cursor >= min_silence_seconds:
        silences.append(_silence(cursor, duration_seconds, "trailing"))

    # Reclassify short internals as pauses: still worth noting, less worth cutting.
    for s in silences:
        if s["kind"] == "internal" and to_seconds(s["endTicks"]) - to_seconds(s["startTicks"]) < 2 * min_silence_seconds:
            s["kind"] = "pause"

    return silences


def _silence(start: float, end: float, kind: str) -> dict[str, Any]:
    return {
        "startSeconds": round(start, 4),
        "endSeconds": round(end, 4),
        "startTicks": str(to_ticks(start)),
        "endTicks": str(to_ticks(end)),
        "kind": kind,
    }


def find_fillers(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Word-level filler hits, from the isFiller flag set during transcription."""
    out = []
    for i, w in enumerate(words):
        if not w.get("isFiller"):
            continue
        out.append(
            {
                "text": w["text"],
                "startTicks": w["startTicks"],
                "endTicks": w["endTicks"],
                "wordIndex": i,
                "confidence": w.get("probability", 0.8),
            }
        )
    return out


def snap_to_word(start: float, end: float, words: list[dict[str, Any]]) -> tuple[float, float]:
    """Expand a range outward to whole-word boundaries so we never cut mid-word."""
    s = start
    e = end
    for w in words:
        ws = to_seconds(w["startTicks"])
        we = to_seconds(w["endTicks"])
        # if the boundary falls inside this word, snap out to the word edge
        if ws < s < we:
            s = ws
        if ws < e < we:
            e = we
    return s, e


def build_candidates(
    *,
    silences: list[dict[str, Any]],
    fillers: list[dict[str, Any]],
    words: list[dict[str, Any]],
    scenes: list[dict[str, Any]],
    duration_seconds: float,
    min_silence_seconds: float = 0.5,
) -> list[dict[str, Any]]:
    """Rule-based cut candidates with guards applied."""
    scene_starts = {round(to_seconds(s["startTicks"]), 2) for s in scenes[1:]} if scenes else set()
    raw: list[dict[str, Any]] = []

    # --- silences ---------------------------------------------------------
    for s in silences:
        s0 = to_seconds(s["startTicks"])
        e0 = to_seconds(s["endTicks"])
        if e0 - s0 < min_silence_seconds:
            continue
        # keep a breath of air around speech so cuts do not feel clipped
        keep = 0.12 if s["kind"] == "pause" else 0.2
        start = s0 + (keep if s["kind"] == "leading" else 0.0)
        end = e0 - (keep if s["kind"] in ("trailing", "internal") else 0.0)
        if end - start < MIN_CUT_SECONDS:
            continue
        raw.append(
            {
                "kind": "silence",
                "startSeconds": start,
                "endSeconds": end,
                "reason": f"{end - start:.2f}s of {s['kind']} silence",
                "confidence": 0.95 if s["kind"] != "pause" else 0.7,
            }
        )

    # --- fillers ----------------------------------------------------------
    for f in fillers:
        s0, e0 = snap_to_word(to_seconds(f["startTicks"]), to_seconds(f["endTicks"]), words)
        # pad slightly so the cut lands between phonemes, not inside one
        s0 = max(0.0, s0 - 0.03)
        e0 = e0 + 0.03
        if e0 - s0 < MIN_CUT_SECONDS:
            e0 = s0 + MIN_CUT_SECONDS
        raw.append(
            {
                "kind": "filler",
                "startSeconds": s0,
                "endSeconds": e0,
                "reason": f'filler word "{f["text"]}"',
                "confidence": round(min(0.95, float(f.get("confidence", 0.8)) + 0.1), 3),
                "wordIndex": f["wordIndex"],
            }
        )

    # --- guards -----------------------------------------------------------
    kept: list[dict[str, Any]] = []
    for c in raw:
        s0, e0 = c["startSeconds"], c["endSeconds"]

        # 3. protect take edges
        if s0 < EDGE_PROTECT_SECONDS:
            s0 = EDGE_PROTECT_SECONDS
        if e0 > duration_seconds - EDGE_PROTECT_SECONDS:
            e0 = duration_seconds - EDGE_PROTECT_SECONDS
        if e0 - s0 < MIN_CUT_SECONDS:
            continue

        # 4. do not cut across a scene boundary
        near_scene = any(s0 <= b <= e0 for b in scene_starts)

        kept.append(
            {
                "kind": c["kind"],
                "startSeconds": s0,
                "endSeconds": e0,
                "reason": c["reason"],
                "confidence": c["confidence"],
                "nearSceneCut": near_scene,
                **({"wordIndex": c["wordIndex"]} if "wordIndex" in c else {}),
            }
        )

    # 2. cap removal per sliding window
    kept = _apply_ratio_cap(kept, duration_seconds)

    # assign stable ids and convert to ticks
    out = []
    for i, c in enumerate(sorted(kept, key=lambda x: x["startSeconds"])):
        out.append(
            {
                "id": f"k{i + 1}",
                "startTicks": str(to_ticks(c["startSeconds"])),
                "endTicks": str(to_ticks(c["endSeconds"])),
                "kind": c["kind"],
                "reason": c["reason"],
                "confidence": round(float(c["confidence"]), 3),
                "evidence": {
                    "nearSceneCut": c["nearSceneCut"],
                    "durationSeconds": round(c["endSeconds"] - c["startSeconds"], 3),
                    **({"wordIndex": c["wordIndex"]} if "wordIndex" in c else {}),
                },
            }
        )
    return out


def _apply_ratio_cap(cands: list[dict[str, Any]], duration_seconds: float) -> list[dict[str, Any]]:
    """Drop the lowest-confidence candidate in any window that would remove more
    than MAX_REMOVAL_RATIO_PER_WINDOW of it."""
    if not cands:
        return []

    cands = sorted(cands, key=lambda c: c["startSeconds"])
    windows = max(1, int(duration_seconds // WINDOW_SECONDS) + 1)

    for _ in range(windows + 1):
        worst_idx = None
        for w in range(windows):
            ws = w * WINDOW_SECONDS
            we = ws + WINDOW_SECONDS
            inside = [
                (i, c)
                for i, c in enumerate(cands)
                if c["endSeconds"] > ws and c["startSeconds"] < we
            ]
            removed = sum(
                min(c["endSeconds"], we) - max(c["startSeconds"], ws) for _, c in inside
            )
            if removed / WINDOW_SECONDS > MAX_REMOVAL_RATIO_PER_WINDOW and inside:
                # sacrifice the least confident cut in this window
                i, _ = min(inside, key=lambda t: t[1]["confidence"])
                worst_idx = i
                break
        if worst_idx is None:
            break
        cands.pop(worst_idx)

    return cands
