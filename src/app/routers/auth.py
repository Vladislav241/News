from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from email_validator import validate_email, EmailNotValidError

from ..db import db
from ..auth.security import (
    create_session_jwt,
    hash_password,
    verify_password,
    new_token_urlsafe,
    token_hash,
    session_cookie_params,
)
from ..auth.email_service import public_base_url, send_email
from ..auth.rate_limit import rate_limit
from ..auth.deps import get_current_user_optional
from ..auth.oauth_google import new_state, new_code_verifier, build_auth_url, exchange_code, fetch_userinfo


router = APIRouter()

SESSION_MINUTES = int(os.getenv("SESSION_MINUTES", "43200"))  # 30 days
VERIFY_MINUTES = int(os.getenv("EMAIL_VERIFY_MINUTES", "60"))
RESET_MINUTES = int(os.getenv("PASSWORD_RESET_MINUTES", "30"))


class RegisterIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: str
    password: str


class ForgotIn(BaseModel):
    email: str


class ResendVerifyIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)


def _validate_email(email: str) -> str:
    try:
        v = validate_email(email, check_deliverability=False)
        return v.normalized
    except EmailNotValidError:
        raise HTTPException(status_code=400, detail="Invalid email")


def _validate_password_strength(password: str) -> None:
    p = password or ""
    if len(p) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    has_letter = any(c.isalpha() for c in p)
    has_digit = any(c.isdigit() for c in p)
    if not (has_letter and has_digit):
        raise HTTPException(status_code=400, detail="Password must contain letters and digits")


@router.get("/api/auth/me")
def me(user=Depends(get_current_user_optional)):
    if not user:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "email_verified": bool(int(user.get("email_verified") or 0)),
            "provider": user.get("provider") or "local",
            "created_at": user.get("created_at"),
            "last_login": user.get("last_login"),
        },
    }


@router.post("/api/auth/register")
def register(payload: RegisterIn, request: Request):
    rate_limit(request, "register", limit=8, window_seconds=60)
    email = _validate_email(payload.email)
    _validate_password_strength(payload.password)

    if db.get_user_by_email(email):
        raise HTTPException(status_code=409, detail="Email already registered")

    user_id = db.create_user_local(email=email, hashed_password=hash_password(payload.password))

    raw = new_token_urlsafe(32)
    db.create_auth_token(user_id=user_id, token_type="verify", token_hash=token_hash(raw), expires_minutes=VERIFY_MINUTES)

    link = f"{public_base_url()}/?verify={raw}"
    send_email(
        to_email=email,
        subject="Verify your email",
        text=f"Welcome to CHECK news.\n\nVerify your email by opening this link:\n{link}\n\nIf you didn't sign up, ignore this email.",
    )

    return {"status": "ok", "message": "Verification email sent"}


@router.post("/api/auth/verify")
def verify_email(token: str, request: Request):
    rate_limit(request, "verify", limit=20, window_seconds=60)
    token = (token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")

    row = db.consume_auth_token(token_type="verify", raw_token=token)
    if not row:
        raise HTTPException(status_code=400, detail="Invalid or expired token")

    db.set_user_email_verified(int(row["user_id"]), True)
    return {"status": "ok", "message": "Email verified"}


@router.post("/api/auth/verify/resend")
def resend_verify(payload: ResendVerifyIn, request: Request):
    """Resend verification email for an existing local account.

    Returns ok even if the email doesn't exist (to reduce user enumeration).
    """
    rate_limit(request, "resend_verify", limit=6, window_seconds=60)
    email = _validate_email(payload.email)
    user = db.get_user_by_email(email)

    if not user:
        return {"status": "ok", "message": "If that email exists, we sent a verification link"}

    if (user.get("provider") or "local") != "local":
        return {"status": "ok", "message": "If that email exists, we sent a verification link"}

    if bool(int(user.get("email_verified") or 0)):
        return {"status": "ok", "message": "Email already verified"}

    raw = new_token_urlsafe(32)
    db.create_auth_token(user_id=int(user["id"]), token_type="verify", token_hash=token_hash(raw), expires_minutes=VERIFY_MINUTES)

    link = f"{public_base_url()}/?verify={raw}"
    send_email(
        to_email=email,
        subject="Verify your email",
        text=f"Verify your email by opening this link:\n{link}\n\nIf you didn't sign up, ignore this email.",
    )
    return {"status": "ok", "message": "Verification email sent"}


@router.post("/api/auth/login")
def login(payload: LoginIn, request: Request, response: Response):
    rate_limit(request, "login", limit=12, window_seconds=60)
    email = _validate_email(payload.email)
    user = db.get_user_by_email(email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if (user.get("provider") or "local") != "local":
        raise HTTPException(status_code=400, detail=f"Use {user['provider']} login for this email")

    if not verify_password(payload.password, user.get("hashed_password") or ""):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    db.update_user_last_login(int(user["id"]))

    token = create_session_jwt(int(user["id"]), email=user["email"], provider="local", minutes=SESSION_MINUTES)
    params = session_cookie_params()
    response.set_cookie(
        params["key"],
        token,
        httponly=params["httponly"],
        secure=params["secure"],
        samesite=params["samesite"],
        path=params["path"],
        max_age=SESSION_MINUTES * 60,
    )
    return {"status": "ok"}


@router.post("/api/auth/logout")
def logout(response: Response):
    params = session_cookie_params()
    response.delete_cookie(params["key"], path=params["path"])
    return {"status": "ok"}


@router.post("/api/auth/forgot")
def forgot(payload: ForgotIn, request: Request):
    rate_limit(request, "forgot", limit=6, window_seconds=60)
    email = _validate_email(payload.email)
    user = db.get_user_by_email(email)

    # Always return ok to avoid user enumeration
    if not user:
        return {"status": "ok", "message": "If that email exists, we sent a reset link"}

    raw = new_token_urlsafe(32)
    db.create_auth_token(user_id=int(user["id"]), token_type="reset", token_hash=token_hash(raw), expires_minutes=RESET_MINUTES)

    link = f"{public_base_url()}/?reset={raw}"
    send_email(
        to_email=email,
        subject="Reset your password",
        text=f"Reset your password by opening this link:\n{link}\n\nIf you didn't request this, ignore this email.",
    )
    return {"status": "ok", "message": "If that email exists, we sent a reset link"}


@router.post("/api/auth/reset")
def reset_password(payload: ResetIn, request: Request):
    rate_limit(request, "reset", limit=10, window_seconds=60)
    _validate_password_strength(payload.new_password)

    row = db.consume_auth_token(token_type="reset", raw_token=payload.token)
    if not row:
        raise HTTPException(status_code=400, detail="Invalid or expired token")

    db.set_user_password(int(row["user_id"]), hash_password(payload.new_password))
    return {"status": "ok", "message": "Password updated"}


# ---------------- OAuth: Google ----------------

@router.get("/api/auth/oauth/google/start")
def google_start(response: Response, request: Request):
    rate_limit(request, "oauth_google_start", limit=20, window_seconds=60)
    st = new_state()
    verifier = new_code_verifier()
    url = build_auth_url(state=st, verifier=verifier)

    params = session_cookie_params()
    response.set_cookie("oauth_state", st, httponly=True, secure=params["secure"], samesite="lax", max_age=600, path="/")
    response.set_cookie("oauth_verifier", verifier, httponly=True, secure=params["secure"], samesite="lax", max_age=600, path="/")

    return {"status": "ok", "url": url}


@router.get("/api/auth/oauth/google/callback")
def google_callback(request: Request, code: str = "", state: str = ""):
    oauth_state = request.cookies.get("oauth_state")
    verifier = request.cookies.get("oauth_verifier")

    if not code or not state or not oauth_state or not verifier or state != oauth_state:
        raise HTTPException(status_code=400, detail="OAuth state mismatch")

    tokens = exchange_code(code=code, verifier=verifier)
    access_token = tokens.get("access_token")
    if not access_token:
        raise HTTPException(status_code=400, detail="No access token from Google")

    info = fetch_userinfo(access_token)
    email = (info.get("email") or "").strip().lower()
    sub = (info.get("sub") or "").strip()
    if not email or not sub:
        raise HTTPException(status_code=400, detail="Could not read Google profile")

    user_id = db.upsert_oauth_user(provider="google", provider_id=sub, email=email)
    db.set_user_email_verified(user_id, True)
    db.update_user_last_login(user_id)

    token = create_session_jwt(user_id, email=email, provider="google", minutes=SESSION_MINUTES)
    params = session_cookie_params()
    resp = RedirectResponse(url="/?login=success", status_code=302)
    resp.set_cookie(
        params["key"],
        token,
        httponly=params["httponly"],
        secure=params["secure"],
        samesite=params["samesite"],
        path=params["path"],
        max_age=SESSION_MINUTES * 60,
    )
    resp.delete_cookie("oauth_state", path="/")
    resp.delete_cookie("oauth_verifier", path="/")
    return resp
