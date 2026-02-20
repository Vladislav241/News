from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..db import db
from ..auth.deps import get_current_user_optional
from ..emailer import send_email


router = APIRouter(prefix="/api")


def _require_user(user):
    if not user or not user.get("id"):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return int(user["id"])


@router.get("/alerts/email")
def get_email_alerts_status(user=Depends(get_current_user_optional)):
    uid = _require_user(user)
    return {"enabled": bool(db.get_user_email_alerts_enabled(uid))}


@router.post("/alerts/email")
def set_email_alerts_status(payload: dict, user=Depends(get_current_user_optional)):
    uid = _require_user(user)
    enabled = bool(payload.get("enabled"))
    db.set_user_email_alerts_enabled_all(uid, enabled)
    return {"ok": True, "enabled": enabled}


@router.post("/alerts/email/test")
def send_test_email(user=Depends(get_current_user_optional)):
    uid = _require_user(user)
    u = db.get_user_by_id(uid) or {}
    to_email = (u.get("email") or "").strip()
    if not to_email:
        raise HTTPException(status_code=400, detail="No email on user")

    ok = send_email(
        to_email,
        subject="CHECKNE. — test email",
        html="<p>If you received this, email delivery is working ✅</p>",
        text="If you received this, email delivery is working.",
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Email send failed — check RESEND_API_KEY/FROM_EMAIL logs")
    return {"ok": True}
