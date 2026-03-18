from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from ..db import db
from ..runtime import background_tasks_disabled, env_name

router = APIRouter()


@router.get('/health')
def health() -> dict:
    db_ok = True
    last = None
    try:
        last = db.get_last_ingest_run()
    except Exception:
        db_ok = False

    status = 'ok' if db_ok else 'degraded'
    return {
        'status': status,
        'app_env': env_name(),
        'background_tasks_disabled': background_tasks_disabled(),
        'db': 'ok' if db_ok else 'error',
        'last_ingest': last,
        'time_utc': datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
