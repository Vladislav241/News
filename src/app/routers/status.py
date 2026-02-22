from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter

from ..db import db

router = APIRouter(prefix="/api")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        v = str(s).strip()
        if not v:
            return None
        # Accept "Z"
        if v.endswith("Z"):
            v = v[:-1] + "+00:00"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _service(status: str, message: str, extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    d: dict[str, Any] = {"status": status, "message": message}
    if extra:
        d.update(extra)
    return d


@router.get("/status")
def status() -> dict[str, Any]:
    generated_at = _utc_now_iso()

    # ---- API/DB ----
    api_state = "operational"
    api_msg = "Operational"
    db_ok = True
    try:
        # Lightweight DB ping
        db._fetchone("SELECT 1 AS ok")
    except Exception:
        db_ok = False
        api_state = "down"
        api_msg = "Database connection failed"

    # ---- Tracking / ingest ----
    tracking_state = "degraded"
    tracking_msg = "No recent ingest data"
    last = None
    try:
        last = db.get_last_ingest_run()
    except Exception:
        last = None

    if not db_ok:
        tracking_state = "down"
        tracking_msg = "Unavailable (DB down)"
    else:
        if last:
            started_at = _parse_iso(last.get("started_at"))
            finished_at = _parse_iso(last.get("finished_at")) or started_at
            run_status = str(last.get("status") or "").lower().strip()

            now = datetime.now(timezone.utc)
            age_min = None
            if finished_at:
                age_min = (now - finished_at).total_seconds() / 60.0

            # Base status from run status
            if run_status in ("ok", "success", "completed", "done"):
                base = "operational"
            elif run_status in ("running",):
                base = "degraded"
            elif run_status:
                base = "degraded"
            else:
                base = "degraded"

            # Age thresholds (tuneable)
            # <= 30 min: ok, 30-120: degraded, > 120: down
            if age_min is None:
                tracking_state = base
                tracking_msg = "Ingest status unknown"
            else:
                if age_min <= 30:
                    tracking_state = "operational"
                    tracking_msg = "Operational"
                elif age_min <= 120:
                    tracking_state = "degraded"
                    tracking_msg = "Delayed updates"
                else:
                    tracking_state = "down"
                    tracking_msg = "No recent updates"

            # If last run failed explicitly, at least degraded
            if run_status in ("failed", "error", "crashed"):
                tracking_state = "down" if age_min is not None and age_min > 120 else "degraded"
                tracking_msg = "Recent ingest errors"

            # Extra info
            tracking_extra = {
                "last_run": {
                    "id": last.get("id"),
                    "status": last.get("status"),
                    "started_at": last.get("started_at"),
                    "finished_at": last.get("finished_at"),
                }
            }
        else:
            tracking_extra = {"last_run": None}

    # ---- Email ----
    # We can only reliably detect configuration, not deliverability.
    import os

    resend_key = (os.getenv("RESEND_API_KEY") or "").strip()
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    email_state = "degraded"
    email_msg = "Not configured"
    if resend_key or smtp_host:
        email_state = "operational"
        email_msg = "Configured"

    if not db_ok:
        # The site can run without DB for email config, but keep it honest
        pass

    return {
        "generated_at": generated_at,
        "services": {
            "web_app": _service("operational", "Operational"),
            "api": _service(api_state, api_msg),
            "tracking": _service(tracking_state, tracking_msg, tracking_extra if "tracking_extra" in locals() else None),
            "email": _service(email_state, email_msg, {"provider": "resend" if resend_key else ("smtp" if smtp_host else "none")}),
        },
    }
