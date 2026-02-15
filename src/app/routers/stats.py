from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..db import db
from ..auth.deps import require_user

router = APIRouter()

def _scalar(sql: str, params: tuple = ()) -> int:
    row = db._fetchone(sql, params)
    if not row:
        return 0
    # psycopg2 RealDictRow supports dict access; sqlite row too
    v = next(iter(row.values())) if hasattr(row, "values") else list(row)[0]
    try:
        return int(v or 0)
    except Exception:
        return 0

@router.get("/api/stats")
def get_stats(user=Depends(require_user)) -> dict:
    """Admin-only service statistics.

    Returns:
      - total_users
      - online_users (active in last 5 minutes)
      - registered_today
    """
    if not user or not bool(user.get("is_admin")):
        raise HTTPException(status_code=403, detail="Admin only")

    db.ensure_schema()

    total_users = _scalar("SELECT COUNT(*) AS c FROM users")

    online_users = _scalar(
        """
        SELECT COUNT(*) AS c
        FROM users
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at >= (now() - interval '5 minutes')
        """
    )

    registered_today = _scalar(
        """
        SELECT COUNT(*) AS c
        FROM users
        WHERE created_at IS NOT NULL
          AND (created_at::timestamptz) >= date_trunc('day', now())
        """
    )

    return {
        "total_users": total_users,
        "online_users": online_users,
        "registered_today": registered_today,
    }
