# src/app/routers/health.py
from __future__ import annotations

from fastapi import APIRouter

from ..db import db

router = APIRouter()


@router.get("/health")
def health() -> dict:
    last = db.get_last_ingest_run()
    return {
        "status": "ok",
        "last_ingest": last,
    }
