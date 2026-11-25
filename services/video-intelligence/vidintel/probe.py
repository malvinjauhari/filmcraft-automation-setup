"""Media probing with ffprobe.

Deliberately independent of FilmCraft: the analysis layer must work when
FilmCraft is not running. FilmCraft's own probe is recorded separately and a
disagreement is logged as a warning, because that signals a colour/rate
assumption difference worth knowing about.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from .timeutil import to_ticks


class ProbeError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 120) -> str:
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError as e:
        raise ProbeError(f"ffprobe not found: {e}") from e
    if r.returncode != 0:
        raise ProbeError(f"ffprobe failed on {cmd[-1]}: {r.stderr.strip()[:400]}")
    return r.stdout


def _fps(rational: str | None) -> float:
    """'30000/1001' -> 29.97. Never trust a rounded fps string."""
    if not rational or rational in ("0/0", "0"):
        return 0.0
    if "/" in rational:
        num, den = rational.split("/", 1)
        try:
            d = float(den)
            return float(num) / d if d else 0.0
        except ValueError:
            return 0.0
    try:
        return float(rational)
    except ValueError:
        return 0.0


def _fps_rational(rational: str | None) -> dict[str, int] | None:
    if not rational or "/" not in rational:
        return None
    num, den = rational.split("/", 1)
    try:
        return {"num": int(num), "den": int(den)}
    except ValueError:
        return None


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def probe_file(path: str | Path, *, hash_file: bool = True) -> dict[str, Any]:
    """Probe one file into a media.json `source` entry."""
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ProbeError(f"file not found: {p}")
    if not p.is_file():
        raise ProbeError(f"not a file: {p}")

    out = _run(
        [
            "ffprobe", "-v", "error",
            "-print_format", "json",
            "-show_format", "-show_streams",
            str(p),
        ]
    )
    info = json.loads(out)

    fmt = info.get("format", {})
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0)
    if duration <= 0:
        raise ProbeError(f"could not determine duration for {p}")

    kind = "video" if v else ("audio" if a else "image")

    src: dict[str, Any] = {
        "path": str(p),
        "sha256": sha256_file(p) if hash_file else "0" * 64,
        "bytes": int(fmt.get("size") or p.stat().st_size),
        "kind": kind,
        "durationTicks": str(to_ticks(duration)),
        "durationSeconds": duration,
    }

    if v:
        src["video"] = {
            "codec": v.get("codec_name", "unknown"),
            "width": int(v.get("width") or 0),
            "height": int(v.get("height") or 0),
            "fps": round(_fps(v.get("r_frame_rate")), 6),
            "fpsRational": _fps_rational(v.get("r_frame_rate")),
            "bitrate": int(v.get("bit_rate") or 0),
            "pixelFormat": v.get("pix_fmt"),
            "colorPrimaries": v.get("color_primaries"),
            "colorTransfer": v.get("color_transfer"),
            "colorMatrix": v.get("color_space"),
        }
        rot = v.get("tags", {}).get("rotate")
        if rot:
            src["video"]["rotation"] = float(rot)

    if a:
        src["audio"] = {
            "codec": a.get("codec_name", "unknown"),
            "sampleRate": int(a.get("sample_rate") or 0),
            "channels": int(a.get("channels") or 0),
            "bitrate": int(a.get("bit_rate") or 0),
            "layout": a.get("channel_layout"),
        }

    return src


def build_manifest(paths: list[str], job_id: str, *, hash_file: bool = True) -> dict[str, Any]:
    """Probe many files into a complete media.json."""
    sources = []
    for i, path in enumerate(paths):
        entry = probe_file(path, hash_file=hash_file)
        entry = {"index": i, **entry, "filmcraftItem": None}
        sources.append(entry)

    if not sources:
        raise ProbeError("no media to probe")

    return {
        "version": "1.0",
        "jobId": job_id,
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "ticksPerSecond": 254016000000,
        "sources": sources,
    }
