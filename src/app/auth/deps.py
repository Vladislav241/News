from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import Depends, HTTPException, Request

from ..db import db
from .security import decode_session_jwt, session_cookie_params


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
        # Used for admin "online" statistics.
        db.touch_user_last_seen(user_id)
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


def require_admin(user: Dict[str, Any] = Depends(require_user)) -> Dict[str, Any]:
    """Admin-only access guard."""
    if not bool(user.get("is_admin")):
        raise HTTPException(status_code=403, detail="Admin access required")
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

    # 1) Always allow same-host requests (robust behind proxies and across http/https).
    try:
        from urllib.parse import urlparse

        req_host = request.headers.get("host")

        def _same_host(v: Optional[str]) -> bool:
            if not v:
                return False
            try:
                p = urlparse(v)
                if not p.netloc:
                    return False
                return (p.netloc == (req_host or ""))
            except Exception:
                return False

        if _same_host(origin) or _same_host(referer):
            return
    except Exception:
        pass

    # 2) If PUBLIC_BASE_URL is configured, allow any Origin/Referer that matches it.
    #    This is useful when Host headers differ due to CDNs/custom domains.
    base = (os.getenv("PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if not base:
        # dev: allow
        return

    def _ok(v: Optional[str]) -> bool:
        if not v:
            return False
        return v.startswith(base)

    if origin and _ok(origin):
        return
    if referer and _ok(referer):
        return

    raise HTTPException(status_code=403, detail="CSRF check failed")
