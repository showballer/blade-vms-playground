"""Opt-in local wire timing; never sends commands or changes motion settings."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import time

_lock = threading.Lock()


def trace_event(event: str, *, monotonic_ns: int | None = None, **values) -> None:
    target = os.environ.get("BLADE_TURNTABLE_TIMING_LOG", "")
    if not target or not Path(target).is_absolute():
        return
    record = {"event": event, "monotonicNs": monotonic_ns if monotonic_ns is not None else time.monotonic_ns(),
              "wallTimeNs": time.time_ns(), **values}
    # A full disk, denied diagnostic path or serialization error must never
    # replace a device result, trigger a retry, or alter stop handling.
    try:
        encoded = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        with _lock:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, encoded)
            finally:
                os.close(fd)
    except (OSError, TypeError, ValueError):
        pass
