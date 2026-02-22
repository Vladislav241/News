from __future__ import annotations

import html as _html
import os
from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse

from ..db import db
from ..unsubscribe_tokens import decode_unsubscribe_token


router = APIRouter()


def _base_url() -> str:
    env = (os.getenv("APP_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    return "https://news-app-qxvw.onrender.com"


def _company_name() -> str:
    return (os.getenv("COMPANY_NAME") or "CHECKNE").strip()


def _company_address() -> str:
    return (os.getenv("COMPANY_POSTAL_ADDRESS") or "Berlin, Germany").strip()


@router.get("/unsubscribe", response_class=HTMLResponse)
def unsubscribe(token: str = Query(default="")):
    token = (token or "").strip()
    payload = decode_unsubscribe_token(token)
    if not payload:
        return HTMLResponse(
            content="""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe — CHECKNE</title></head>
<body style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:24px;background:#fafafa;color:#111;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:16px;padding:22px;">
    <h1 style="margin:0 0 8px;font-size:22px;">Unsubscribe link is invalid</h1>
    <p style="margin:0 0 14px;color:#555;line-height:1.5;">This unsubscribe link is missing, expired, or was already used.</p>
    <a href=""" + _base_url() + """ style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:700;">Open CHECKNE</a>
  </div>
</body></html>""",
            status_code=400,
        )

    try:
        user_id = int(payload.get("sub") or 0)
    except Exception:
        user_id = 0

    if user_id:
        # One-click unsubscribe: disable all email alerts for this user.
        db.set_user_email_alerts_enabled_all(user_id, False)

    name = _html.escape(_company_name())
    addr = _html.escape(_company_address())
    return HTMLResponse(
        content=f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed — {name}</title></head>
<body style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:24px;background:#fafafa;color:#111;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:16px;padding:22px;">
    <h1 style="margin:0 0 8px;font-size:22px;">You’re unsubscribed</h1>
    <p style="margin:0 0 14px;color:#555;line-height:1.5;">
      Email alerts for tracked events have been turned off for this account.
    </p>

    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <a href="{_base_url()}/#/tracking" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:700;">Manage alerts</a>
      <a href="{_base_url()}" style="display:inline-block;background:#fff;color:#111;text-decoration:none;padding:10px 14px;border-radius:12px;font-weight:700;border:1px solid #ddd;">Back to CHECKNE</a>
    </div>

    <div style="margin-top:18px;color:#888;font-size:12px;line-height:1.5;">
      {name} • {addr}<br>
      If you unsubscribed by mistake, you can re-enable alerts in Tracking.
    </div>
  </div>
</body></html>"""
    )
