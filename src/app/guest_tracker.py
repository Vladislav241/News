from __future__ import annotations

import threading
import time
from typing import Dict

# Very small in-memory tracker for "guest online".
#
# Important: this is *approximate* and resets on container restart.
# For production-grade analytics you would use Redis + TTL.

_LOCK = threading.Lock()
_LAST_SEEN_BY_IP: Dict[str, float] = {}


def mark(ip: str | None) -> None:
    if not ip:
        return
    now = time.time()
    with _LOCK:
        _LAST_SEEN_BY_IP[str(ip)] = now


def count_active(window_seconds: int = 300) -> int:
    """Count unique guest IPs active in the last window_seconds."""
    now = time.time()
    cutoff = now - float(window_seconds)
    with _LOCK:
        # cleanup + count
        dead = [ip for ip, ts in _LAST_SEEN_BY_IP.items() if ts < cutoff]
        for ip in dead:
            _LAST_SEEN_BY_IP.pop(ip, None)
        return len(_LAST_SEEN_BY_IP)
