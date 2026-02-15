from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, Request

from ..db import db
from .security import decode_session_jwt, session_cookie_params

def touch_user_activity(user_id: int) -> None:
    """Update user's last_seen_at for online tracking (fail-open)."""
    try:
        db.execute("UPDATE users SET last_seen_at = now() WHERE id = ?", (int(user_id),))
    except Exception:
        pass



def get_current_user_optional(request: Request) -> Optional[Dict[str, Any]]:
    params = session_cookie_params()
    token = request.cookies.get(params["key"])
    if not token:
        return None
    payload = decode_session_jwt(token)
    if not payload:
        return None
    try:
        user_id = int(payload.get("sub") or 0)
    except Exception:
        return None
    if user_id <= 0:
        return None
    user = db.get_user_by_id(user_id)
    if user:
        touch_user_activity(int(user.get('id') or user_id))
    return user


def require_user(user: Optional[Dict[str, Any]] = Depends(get_current_user_optional)) -> Dict[str, Any]:
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    # Optional: enforce verified email for local accounts
    enforce = (os.getenv("REQUIRE_EMAIL_VERIFIED") or "").strip().lower() in ("1", "true", "yes")
    if enforce:
        if (user.get("provider") or "local") == "local" and not bool(int(user.get("email_verified") or 0)):
            raise HTTPException(status_code=403, detail="Email not verified")
    return user


def csrf_origin_check(request: Request) -> None:
    """Basic CSRF defense for cookie-based auth.

    - Only applied to unsafe methods.
    - Allows same-origin requests.

    Set PUBLIC_BASE_URL in Render.
    """
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return

    # If no session cookie, no need to enforce
    params = session_cookie_params()
    if params["key"] not in request.cookies:
        return

    origin = request.headers.get("origin")
    referer = request.headers.get("referer")

    base = (os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if not base:
        # dev: allow
        return

    allowed = base

    def _ok(v: Optional[str]) -> bool:
        if not v:
            return False
        return v.startswith(allowed)

    if origin and _ok(origin):
        return
    if referer and _ok(referer):
        return

    raise HTTPException(status_code=403, detail="CSRF check failed")