# src/app/routers/debug.py
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter

from ..db import db

router = APIRouter(prefix="/api/debug", tags=["debug"])


@router.get("/last_ingest")
def last_ingest() -> dict[str, Any]:
    db.ensure_schema()
    run = db.get_last_ingest_run()
    if not run:
        return {"status": "ok", "run": None}

    try:
        run["stats"] = json.loads(run.get("stats_json") or "{}")
    except Exception:
        run["stats"] = {}

    return {"status": "ok", "run": run}
