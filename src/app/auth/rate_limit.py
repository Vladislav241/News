from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request


# Very small in-memory rate limiter (good enough for early-stage + Render single instance).
# Keyed by: (ip, bucket)
_STORE: Dict[str, Deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    # Render / proxies often set X-Forwarded-For.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request, bucket: str, limit: int, window_seconds: int) -> None:
    ip = _client_ip(request)
    key = f"{ip}:{bucket}"
    now = time.time()
    q = _STORE[key]

    # Drop old hits
    while q and q[0] <= now - window_seconds:
        q.popleft()

    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests")

    q.append(now)
