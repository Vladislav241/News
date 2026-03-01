from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth.deps import get_current_user_optional


router = APIRouter(prefix="/api", tags=["report"])


class ReportPayload(BaseModel):
    # The cluster/event identifier shown in the UI
    cluster_id: int = Field(..., ge=0)

    # Optional metadata so the report is useful inside Discord
    title: Optional[str] = None
    page_url: Optional[str] = None

    # Reason chosen by the user
    reason: str = Field(..., min_length=2, max_length=80)

    # Optional free-form details
    message: Optional[str] = Field(None, max_length=2000)


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _short(s: Optional[str], n: int) -> str:
    if not s:
        return ""
    s2 = str(s).strip()
    return s2 if len(s2) <= n else (s2[: n - 1] + "…")


@router.post("/report")
def report_news(
    payload: ReportPayload,
    request: Request,
    user=Depends(get_current_user_optional),
):
    """Receive a user report and forward it to Discord via webhook."""

    webhook = os.getenv("DISCORD_REPORT_WEBHOOK", "").strip()
    if not webhook:
        raise HTTPException(
            status_code=503,
            detail="Reporting is not configured on the server (missing DISCORD_REPORT_WEBHOOK).",
        )

    # Identify user (optional)
    user_label = "Guest"
    user_id = None
    user_email = None
    try:
        if user:
            user_id = getattr(user, "id", None) or (user.get("id") if isinstance(user, dict) else None)
            user_email = getattr(user, "email", None) or (user.get("email") if isinstance(user, dict) else None)
    except Exception:
        pass
    if user_email:
        user_label = str(user_email)
    elif user_id is not None:
        user_label = f"User #{user_id}"

    # Request metadata
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")
    referer = request.headers.get("referer", "")

    title = _short(payload.title, 180) or f"Cluster {payload.cluster_id}"
    reason = _short(payload.reason, 80)
    msg = _short(payload.message, 2000)
    page_url = _short(payload.page_url, 500) or ""

    embed: dict[str, Any] = {
        "title": f"📝 Report: {title}",
        "description": msg or "(no additional details)",
        "color": 0x111113,
        "fields": [
            {"name": "Reason", "value": reason or "(unknown)", "inline": True},
            {"name": "Cluster ID", "value": str(payload.cluster_id), "inline": True},
            {"name": "Reporter", "value": _short(user_label, 200) or "Guest", "inline": False},
        ],
        "footer": {"text": f"{_iso_now()} · ip {ip}"},
    }

    if page_url:
        embed["url"] = page_url
        embed["fields"].append({"name": "Page", "value": page_url, "inline": False})
    elif referer:
        embed["fields"].append({"name": "Referer", "value": _short(referer, 500), "inline": False})

    if ua:
        embed["fields"].append({"name": "User-Agent", "value": _short(ua, 250), "inline": False})

    try:
        r = requests.post(
            webhook,
            json={
                "content": "",
                "embeds": [embed],
                "allowed_mentions": {"parse": []},
            },
            timeout=8,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail="Discord webhook rejected the report")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Could not forward report to Discord")

    return {"ok": True}
