from __future__ import annotations

import base64
import hashlib
import os
import secrets
from urllib.parse import urlencode

import requests


def _client_id() -> str:
    return (os.getenv("GOOGLE_CLIENT_ID") or "").strip()


def _client_secret() -> str:
    return (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()


def _redirect_uri() -> str:
    return (os.getenv("GOOGLE_REDIRECT_URI") or "").strip()


def new_state() -> str:
    return secrets.token_urlsafe(16)


def new_code_verifier() -> str:
    return secrets.token_urlsafe(32)


def _code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def build_auth_url(state: str, verifier: str) -> str:
    cid = _client_id()
    redir = _redirect_uri()
    if not cid or not redir:
        raise RuntimeError("Google OAuth is not configured")

    params = {
        "client_id": cid,
        "redirect_uri": redir,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
        "code_challenge": _code_challenge(verifier),
        "code_challenge_method": "S256",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)


def exchange_code(code: str, verifier: str) -> dict:
    data = {
        "code": code,
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "redirect_uri": _redirect_uri(),
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }
    r = requests.post("https://oauth2.googleapis.com/token", data=data, timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_userinfo(access_token: str) -> dict:
    r = requests.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()
