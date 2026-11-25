"""Voice activity detection via Silero, running on the ONNX asset bundled with
faster-whisper.

Deliberately does NOT import torch. The `silero-vad` PyPI package drags in a
~539 MB torch wheel that buys nothing on a CPU-only machine; faster_whisper
ships the identical model as silero_vad_v6.onnx and runs it through onnxruntime.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .audio import load_float32
from .timeutil import to_ticks

DEFAULT_THRESHOLD = 0.5
DEFAULT_MIN_SILENCE_MS = 500
DEFAULT_PAD_MS = 200


def speech_spans(
    wav: str | Path,
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_silence_ms: int = DEFAULT_MIN_SILENCE_MS,
    pad_ms: int = DEFAULT_PAD_MS,
    sample_rate: int = 16000,
) -> list[dict[str, Any]]:
    """Return speech spans as [{startTicks, endTicks}] plus raw seconds."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio = load_float32(wav, sample_rate=sample_rate)
    if audio.size == 0:
        return []

    opts = VadOptions(
        threshold=threshold,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=pad_ms,
    )
    raw = get_speech_timestamps(audio, opts, sampling_rate=sample_rate)

    spans = []
    for s in raw:
        start = s["start"] / sample_rate
        end = s["end"] / sample_rate
        if end <= start:
            continue
        spans.append(
            {
                "startSeconds": round(start, 4),
                "endSeconds": round(end, 4),
                "startTicks": str(to_ticks(start)),
                "endTicks": str(to_ticks(end)),
            }
        )
    return spans


def merge_spans(spans: list[dict[str, Any]], gap_seconds: float = 0.05) -> list[dict[str, Any]]:
    """Merge spans separated by less than `gap_seconds` so tiny breath gaps do
    not fragment the speech map."""
    if not spans:
        return []
    out = [dict(spans[0])]
    for s in spans[1:]:
        prev = out[-1]
        if s["startSeconds"] - prev["endSeconds"] <= gap_seconds:
            prev["endSeconds"] = s["endSeconds"]
            prev["endTicks"] = s["endTicks"]
        else:
            out.append(dict(s))
    return out
