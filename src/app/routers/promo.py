from __future__ import annotations

import html
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, HttpUrl

from ..auth.deps import get_current_user_optional, require_user
from ..db import db

router = APIRouter()


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _cfg() -> dict:
    enabled = _env_bool("SHARE_PROMO_ENABLED", False)
    target = max(1, int(os.getenv("SHARE_PROMO_TARGET_SHARES", "10") or 10))
    reward_days = max(1, int(os.getenv("SHARE_PROMO_REWARD_DAYS", "14") or 14))
    campaign_id = (os.getenv("SHARE_PROMO_CAMPAIGN_ID") or f"share-{target}-{reward_days}").strip()
    headline = (os.getenv("SHARE_PROMO_HEADLINE") or "Get 2 weeks of Pro for free").strip()
    subline = (os.getenv("SHARE_PROMO_SUBLINE") or f"Share {target} different news events on X or Threads and unlock Pro for {reward_days} days.").strip()
    return {
        "enabled": enabled,
        "campaign_id": campaign_id,
        "target_shares": target,
        "reward_days": reward_days,
        "headline": headline,
        "subline": subline,
        "platforms": ["x", "threads"],
    }


def _public_base_url() -> str:
    return (os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_BASE_URL") or "http://127.0.0.1:8000").strip().rstrip("/")


def _normalize_platform(v: str) -> str:
    s = str(v or "").strip().lower()
    if s in ("x", "twitter", "twitter/x"):
        return "x"
    if s in ("threads", "thread"):
        return "threads"
    raise HTTPException(status_code=400, detail="Unsupported platform")


def _get_user_plan(user_id: int) -> str:
    sub = db.get_user_subscription(int(user_id))
    if not sub:
        return "free"
    return str(sub.get("plan") or "free").strip().lower()


def _eligible_for_reward(user_id: int) -> tuple[bool, str]:
    plan = _get_user_plan(user_id)
    if plan in ("pro", "analyst"):
        return False, "already_paid_or_active"
    return True, "ok"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _normalize_post_url(url: str, platform: str) -> str:
    raw = (url or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Missing post URL")
    try:
        parsed = urlparse(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid post URL")
    host = (parsed.netloc or "").lower()
    path = parsed.path or ""
    if platform == "x":
        if not any(h in host for h in ("x.com", "twitter.com")) or "/status/" not in path:
            raise HTTPException(status_code=400, detail="Provide a public X post URL")
    elif platform == "threads":
        if "threads.net" not in host or ("/post/" not in path and "/t/" not in path):
            raise HTTPException(status_code=400, detail="Provide a public Threads post URL")
    return raw


def _verify_post_contains_share(post_url: str, attempt: dict) -> tuple[bool, str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    try:
        resp = requests.get(post_url, headers=headers, timeout=12, allow_redirects=True)
    except Exception:
        return False, "fetch_failed"
    if resp.status_code >= 400:
        return False, f"http_{resp.status_code}"
    body = html.unescape(resp.text or "")
    if not body:
        return False, "empty_response"

    article_url = str(attempt.get("article_url") or "")
    share_url = str(attempt.get("share_url") or "")
    token = str(attempt.get("share_token") or "")
    needles = [token, share_url, article_url]
    for needle in needles:
        if needle and needle in body:
            return True, "matched_public_html"
    decoded = body.replace("\\/", "/")
    for needle in needles:
        if needle and needle in decoded:
            return True, "matched_decoded_html"
    if token and re.search(re.escape(token), body, flags=re.I):
        return True, "matched_token_regex"
    return False, "share_link_not_found"


class StartShareIn(BaseModel):
    cluster_id: int
    platform: str


class SubmitShareIn(BaseModel):
    attempt_id: int
    post_url: HttpUrl


@router.get("/api/promo/share/config")
def promo_share_config(user=Depends(get_current_user_optional)):
    cfg = _cfg()
    out = dict(cfg)
    out["authenticated"] = bool(user)
    out["eligible"] = False
    out["reason"] = "login_required"
    out["progress"] = 0
    out["reward_active_until"] = None
    if user:
        eligible, reason = _eligible_for_reward(int(user["id"]))
        prog = db.get_share_promo_progress(int(user["id"]))
        out["eligible"] = bool(eligible)
        out["reason"] = reason
        out["progress"] = int(prog.get("confirmed_unique_clusters") or 0)
        reward = prog.get("reward") or {}
        out["reward_active_until"] = reward.get("ends_at")
    return out


@router.get("/api/promo/share/status")
def promo_share_status(user=Depends(require_user)):
    cfg = _cfg()
    eligible, reason = _eligible_for_reward(int(user["id"]))
    prog = db.get_share_promo_progress(int(user["id"]))
    reward = prog.get("reward") or {}
    return {
        **cfg,
        "eligible": bool(eligible),
        "reason": reason,
        "progress": int(prog.get("confirmed_unique_clusters") or 0),
        "confirmed_attempts": int(prog.get("confirmed_attempts") or 0),
        "pending_attempts": int(prog.get("pending_attempts") or 0),
        "reward_active_until": reward.get("ends_at"),
        "reward_granted": bool(reward),
    }


@router.post("/api/promo/share/start")
def promo_share_start(payload: StartShareIn, user=Depends(require_user)):
    cfg = _cfg()
    if not cfg["enabled"]:
        raise HTTPException(status_code=404, detail="Campaign is disabled")
    eligible, reason = _eligible_for_reward(int(user["id"]))
    if not eligible:
        raise HTTPException(status_code=409, detail=reason)

    platform = _normalize_platform(payload.platform)
    cluster_id = int(payload.cluster_id)
    meta = db.get_cluster_meta(cluster_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Story not found")

    updated_at = meta.get("updated_at") or meta.get("created_at")
    v = "0"
    if updated_at:
        try:
            v = str(int(datetime.fromisoformat(str(updated_at).replace("Z", "+00:00")).timestamp()))
        except Exception:
            v = str(int(_utc_now().timestamp()))
    base = _public_base_url()
    token = secrets.token_urlsafe(9)
    article_url = f"{base}/share/{cluster_id}?v={v}"
    share_url = f"{base}/share/{cluster_id}?v={v}&sref={token}"
    attempt = db.create_share_promo_attempt(int(user["id"]), cluster_id, platform, token, article_url, share_url)
    title = str(meta.get("title") or "CHECKNE.").strip()
    return {
        "attempt_id": int(attempt["id"]),
        "platform": platform,
        "share_url": share_url,
        "article_url": article_url,
        "share_text": f"Trust score • {title}",
        "token": token,
    }


@router.post("/api/promo/share/submit")
def promo_share_submit(payload: SubmitShareIn, user=Depends(require_user)):
    cfg = _cfg()
    if not cfg["enabled"]:
        raise HTTPException(status_code=404, detail="Campaign is disabled")
    attempt = db.get_share_promo_attempt(int(payload.attempt_id), int(user["id"]))
    if not attempt:
        raise HTTPException(status_code=404, detail="Share attempt not found")
    if str(attempt.get("status") or "") == "confirmed":
        prog = db.get_share_promo_progress(int(user["id"]))
        return {"status": "already_confirmed", "progress": int(prog.get("confirmed_unique_clusters") or 0), "target": cfg["target_shares"], "reward_granted": bool((prog.get("reward") or {}))}

    post_url = _normalize_post_url(str(payload.post_url), str(attempt.get("platform") or ""))
    ok, detail = _verify_post_contains_share(post_url, attempt)
    row = db.update_share_promo_attempt_submission(int(attempt["id"]), int(user["id"]), post_url, "confirmed" if ok else "rejected", detail, confirmed=ok)
    prog = db.get_share_promo_progress(int(user["id"]))

    reward_granted = False
    reward_until = None
    if ok and int(prog.get("confirmed_unique_clusters") or 0) >= int(cfg["target_shares"]):
        reward = prog.get("reward") or {}
        if not reward:
            starts_at = _utc_now()
            ends_at = starts_at + timedelta(days=int(cfg["reward_days"]))
            reward = db.grant_share_promo_reward(int(user["id"]), "pro", starts_at.isoformat(), ends_at.isoformat(), source="share_campaign")
            reward_granted = True
            reward_until = reward.get("ends_at")
        else:
            reward_until = reward.get("ends_at")

    if not ok:
        raise HTTPException(status_code=400, detail={
            "message": "We could not verify this public post yet. Make sure the shared CHECKNE link is visible in the post and that the post is public.",
            "reason": detail,
            "progress": int(prog.get("confirmed_unique_clusters") or 0),
            "target": cfg["target_shares"],
        })

    return {
        "status": "confirmed",
        "attempt": row,
        "progress": int(prog.get("confirmed_unique_clusters") or 0),
        "target": cfg["target_shares"],
        "reward_granted": reward_granted,
        "reward_active_until": reward_until,
    }
