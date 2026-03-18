from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from jose import JWTError, jwt

from .runtime import require_env


def _secret_key() -> str:
    return require_env("AUTH_SECRET_KEY", "JWT_SECRET_KEY")


def create_unsubscribe_token(user_id: int, email: str, days: int = 365) -> str:
    """Create a signed token for one-click unsubscribe.

    The token identifies the user and expires after `days`.
    """
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=max(1, int(days)))
    payload: Dict[str, Any] = {
        "typ": "unsub",
        "sub": str(int(user_id)),
        "email": (email or "").strip().lower(),
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _secret_key(), algorithm="HS256")


def decode_unsubscribe_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(token, _secret_key(), algorithms=["HS256"])
        if payload.get("typ") != "unsub":
            return None
        return payload
    except JWTError:
        return None
    except Exception:
        return None
