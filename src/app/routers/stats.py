from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from ..auth.deps import require_admin
from ..db import db
from ..guest_tracker import count_active

router = APIRouter(prefix="/api", tags=["stats"])


def _scalar(sql: str, params: tuple = ()) -> int:
    row = db._fetchone(sql, params)  # type: ignore[attr-defined]
    if not row:
        return 0
    # db._fetchone returns dict-like row
    v = next(iter(row.values()))
    try:
        return int(v)
    except Exception:
        return 0


@router.get("/stats")
def get_stats(_admin=Depends(require_admin)):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = now - timedelta(minutes=5)

    total_users = _scalar("SELECT COUNT(*) AS c FROM users")
    registered_today = _scalar(
        "SELECT COUNT(*) AS c FROM users WHERE created_at >= ?",
        (today_start.isoformat(),),
    )

    # Logged-in online (based on last_seen_at updated on authenticated requests)
    online_users = _scalar(
        """
        SELECT COUNT(*) AS c
        FROM users
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at >= ?
        """,
        (cutoff.isoformat(),),
    )

    # Guests online (approximate; in-memory; resets on restart)
    guest_online = int(count_active(300))

    return {
        "total_users": total_users,
        "registered_today": registered_today,
        "online_users": online_users,
        "guest_online": guest_online,
        "online_total": int(online_users) + int(guest_online),
        "window_seconds": 300,
    }
