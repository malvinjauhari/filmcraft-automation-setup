"""Audio extraction. Whisper wants 16 kHz mono PCM; decoding from a clean WAV is
more reliable and faster than reading the video container directly."""

from __future__ import annotations

import subprocess
from pathlib import Path

SAMPLE_RATE = 16000


class AudioError(RuntimeError):
    pass


def extract_wav(src: str | Path, out: str | Path, *, sample_rate: int = SAMPLE_RATE) -> Path:
    """Extract a 16 kHz mono WAV. Never writes near the source."""
    src_p = Path(src).expanduser().resolve()
    out_p = Path(out).expanduser().resolve()
    if not src_p.exists():
        raise AudioError(f"source not found: {src_p}")
    out_p.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg", "-y", "-nostdin",
        "-i", str(src_p),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-c:a", "pcm_s16le",
        str(out_p),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise AudioError(f"ffmpeg extract failed: {r.stderr.strip()[-600:]}")
    if not out_p.exists() or out_p.stat().st_size < 1024:
        raise AudioError(f"ffmpeg produced no usable audio from {src_p}")
    return out_p


def load_float32(wav: str | Path, *, sample_rate: int = SAMPLE_RATE):
    """Read a WAV into float32 mono in [-1, 1], as Silero expects."""
    import wave

    import numpy as np

    with wave.open(str(wav), "rb") as w:
        if w.getnchannels() != 1:
            raise AudioError(f"expected mono, got {w.getnchannels()} channels")
        if w.getframerate() != sample_rate:
            raise AudioError(f"expected {sample_rate} Hz, got {w.getframerate()}")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
