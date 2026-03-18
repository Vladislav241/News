from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from jose import JWTError, jwt

from ..runtime import require_env
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHash

# Argon2 is a modern password hashing algorithm and avoids bcrypt backend issues on newer Pythons.
PWD_HASHER = PasswordHasher()


def hash_password(password: str) -> str:
    # Guard against weird whitespace/newline issues coming from clients.
    password = (password or "").strip()
    if not password:
        raise ValueError("Password cannot be empty.")
    return PWD_HASHER.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    try:
        return PWD_HASHER.verify(hashed_password, (password or "").strip())
    except (VerifyMismatchError, InvalidHash, ValueError):
        return False
    except Exception:
        return False


def _secret_key() -> str:
    return require_env("AUTH_SECRET_KEY", "JWT_SECRET_KEY")


def create_session_jwt(user_id: int, email: str, provider: str, minutes: int) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=minutes)
    payload = {
        "sub": str(user_id),
        "email": email,
        "provider": provider,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _secret_key(), algorithm="HS256")


def decode_session_jwt(token: str) -> Optional[Dict[str, Any]]:
    try:
        return jwt.decode(token, _secret_key(), algorithms=["HS256"])
    except JWTError:
        return None


def new_token_urlsafe(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(raw_token: str) -> str:
    # simple deterministic hash (not reversible). Good enough for reset/verify tokens.
    import hashlib

    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def session_cookie_params() -> Dict[str, Any]:
    secure = (os.getenv("COOKIE_SECURE") or "").strip().lower() in ("1", "true", "yes")
    samesite = (os.getenv("COOKIE_SAMESITE") or "lax").strip().lower()
    if samesite not in ("lax", "strict", "none"):
        samesite = "lax"
    return {
        "key": "session",
        "httponly": True,
        "secure": secure,
        "samesite": samesite,
        "path": "/",
    }
