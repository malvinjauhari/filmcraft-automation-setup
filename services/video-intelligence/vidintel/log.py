"""Structured JSON logging. Every stage writes one line per event so a job can
be reconstructed from logs alone."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any


class Log:
    def __init__(self, name: str, path: Path | None = None, echo: bool = True):
        self.name = name
        self.path = path
        self.echo = echo
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)

    def event(self, level: str, msg: str, **fields: Any) -> None:
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "level": level,
            "stage": self.name,
            "msg": msg,
            **fields,
        }
        line = json.dumps(rec, ensure_ascii=False, default=str)
        if self.path:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        if self.echo:
            icon = {"info": " ", "warn": "!", "error": "x", "done": "+"}.get(level, " ")
            print(f"[{icon}] {msg}" + (f"  {fields}" if fields else ""), file=sys.stderr)

    def info(self, msg: str, **f: Any) -> None:
        self.event("info", msg, **f)

    def warn(self, msg: str, **f: Any) -> None:
        self.event("warn", msg, **f)

    def error(self, msg: str, **f: Any) -> None:
        self.event("error", msg, **f)

    def done(self, msg: str, **f: Any) -> None:
        self.event("done", msg, **f)
