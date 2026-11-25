"""Speech-to-text with word-level timestamps.

Key choices, each learned from a real failure mode:
  - transcribe a clean 16 kHz WAV, never the container
  - word_timestamps=True is mandatory for filler removal and tight subtitles
  - condition_on_previous_text=False prevents the repetition loops Whisper
    falls into on long pauses
  - drop hallucinated segments: Whisper invents text over silence, and the
    no_speech_prob / avg_logprob pair is the reliable signal
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .timeutil import to_ticks

# Segments worse than these are Whisper inventing text over silence.
MAX_NO_SPEECH_PROB = 0.6
MIN_AVG_LOGPROB = -1.0

FILLERS_ID = {
    "eee", "eh", "e", "emm", "em", "hmm", "hm", "mm", "anu", "apa",
    "gitu", "gituh", "kayak", "kayaknya", "gimana", "ya", "kan", "nah",
}
FILLERS_EN = {"um", "uh", "erm", "er", "like", "you", "know", "so"}


def default_model_dir() -> Path:
    return Path(
        os.environ.get(
            "VIDINTEL_MODEL_DIR",
            str(Path(__file__).resolve().parents[3] / "workspace" / "models"),
        )
    )


def load_model(
    size: str = "base",
    *,
    model_dir: Path | None = None,
    compute_type: str = "int8",
):
    """Load a Whisper model on CPU. Downloads on first use into model_dir."""
    from faster_whisper import WhisperModel

    d = model_dir or default_model_dir()
    d.mkdir(parents=True, exist_ok=True)
    return WhisperModel(
        size,
        device="cpu",
        compute_type=compute_type,
        download_root=str(d),
        cpu_threads=max(1, (os.cpu_count() or 4) - 1),
    )


def _is_filler(text: str, language: str) -> bool:
    t = text.strip().lower().strip(".,!?;:")
    if not t:
        return False
    if language in ("id", "mixed") and t in FILLERS_ID:
        return True
    if language in ("en", "mixed") and t in FILLERS_EN:
        return True
    return False


def transcribe(
    wav: str | Path,
    *,
    model_size: str = "base",
    language: str = "id",
    model_dir: Path | None = None,
    model=None,
    log=None,
) -> dict[str, Any]:
    """Transcribe a WAV into the transcript.json shape (minus jobId/sourceIndex).

    The audio is read as a float32 array rather than handed to Whisper as a path.
    faster-whisper 1.2.1 decodes a path with PyAV, calling
    `av.open(..., metadata_errors="ignore")` — a kwarg PyAV 19 removed, so the
    path form dies with `TypeError: open() got an unexpected keyword argument`.
    Passing the samples directly skips that code path, is one decode faster, and
    keeps us on the exact 16 kHz mono we already normalised.
    """
    if model is None:
        if log:
            log.info("loading whisper model", size=model_size)
        model = load_model(model_size, model_dir=model_dir)

    from .audio import load_float32

    audio = load_float32(wav)
    if audio.size == 0:
        raise ValueError(f"no audio samples in {wav}")

    segments_iter, info = model.transcribe(
        audio,
        language=None if language == "auto" else language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        condition_on_previous_text=False,
        beam_size=5,
    )

    words: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []
    dropped = 0

    for seg in segments_iter:
        no_speech = getattr(seg, "no_speech_prob", 0.0) or 0.0
        avg_logprob = getattr(seg, "avg_logprob", 0.0) or 0.0

        if no_speech > MAX_NO_SPEECH_PROB or avg_logprob < MIN_AVG_LOGPROB:
            dropped += 1
            continue

        seg_index = len(segments)
        word_start = len(words)

        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text:
                continue
            words.append(
                {
                    "text": text,
                    "startTicks": str(to_ticks(max(0.0, w.start))),
                    "endTicks": str(to_ticks(max(w.start, w.end))),
                    "probability": round(float(getattr(w, "probability", 0.0) or 0.0), 4),
                    "isFiller": _is_filler(text, language),
                    "segmentIndex": seg_index,
                }
            )

        if len(words) == word_start:
            continue  # segment had no usable words

        segments.append(
            {
                "index": seg_index,
                "startTicks": str(to_ticks(max(0.0, seg.start))),
                "endTicks": str(to_ticks(max(seg.start, seg.end))),
                "text": (seg.text or "").strip(),
                "wordStart": word_start,
                "wordEnd": len(words),
                "avgLogprob": round(avg_logprob, 4),
                "noSpeechProb": round(no_speech, 4),
            }
        )

    if log and dropped:
        log.warn("dropped hallucinated segments", count=dropped)

    return {
        "language": info.language if info else language,
        "languageProbability": round(float(info.language_probability), 4) if info else 0.0,
        "model": f"whisper-{model_size}-int8",
        "words": words,
        "segments": segments,
    }
