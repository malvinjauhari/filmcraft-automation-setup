"""Time model shared by every analysis module.

FilmCraft's tick is the single unit of truth: 254,016,000,000 per second
(48000 x 5292). JSON carries ticks as strings so the value survives the
JavaScript float boundary intact.
"""

TICKS_PER_SECOND = 254_016_000_000


def to_ticks(seconds: float) -> int:
    """Seconds -> integer ticks. Single rounding point in the system."""
    if seconds is None or seconds < 0:
        raise ValueError(f"to_ticks: need a non-negative number, got {seconds!r}")
    return round(seconds * TICKS_PER_SECOND)


def to_seconds(ticks: int | str) -> float:
    """Ticks -> float seconds. Display and API boundary only."""
    return int(ticks) / TICKS_PER_SECOND


def ticks_str(seconds: float) -> str:
    """Seconds -> tick string, ready for JSON."""
    return str(to_ticks(seconds))


def fmt_seconds(ticks: int | str) -> str:
    """Human-readable duration for logs and reports."""
    total = to_seconds(ticks)
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = total % 60
    if h:
        return f"{h}h{m:02d}m{s:04.1f}s"
    if m:
        return f"{m}m{s:04.1f}s"
    return f"{s:.2f}s"
