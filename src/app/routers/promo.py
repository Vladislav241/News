from __future__ import annotations

import html
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

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


def _extract_strings(value: Any) -> list[str]:
    out: list[str] = []
    if value is None:
        return out
    if isinstance(value, str):
        s = value.strip()
        if s:
            out.append(s)
        return out
    if isinstance(value, dict):
        for v in value.values():
            out.extend(_extract_strings(v))
        return out
    if isinstance(value, (list, tuple, set)):
        for v in value:
            out.extend(_extract_strings(v))
        return out
    try:
        s = str(value).strip()
        if s:
            out.append(s)
    except Exception:
        pass
    return out


def _normalize_url_loose(url: str) -> str:
    raw = (url or '').strip()
    if not raw:
        return ''
    try:
        parsed = urlparse(raw)
    except Exception:
        return raw.rstrip('/')
    query = []
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        if k.lower() in ('utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'):
            continue
        query.append((k, v))
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip('/'), '', urlencode(query), '')).rstrip('/')


def _share_needles(attempt: dict) -> list[str]:
    article_url = _normalize_url_loose(str(attempt.get('article_url') or ''))
    share_url = _normalize_url_loose(str(attempt.get('share_url') or ''))
    token = str(attempt.get('share_token') or '').strip()
    out: list[str] = []
    for raw in (share_url, article_url):
        if not raw:
            continue
        out.append(raw)
        try:
            p = urlparse(raw)
            host_path = f"{p.netloc.lower()}{p.path}".rstrip('/')
            if host_path:
                out.append(host_path)
            if p.path:
                out.append(p.path.rstrip('/'))
            if p.query:
                out.append(f"{p.path}?{p.query}")
        except Exception:
            pass
    if token:
        out.append(token)
    seen: set[str] = set()
    needles: list[str] = []
    for item in out:
        s = (item or '').strip()
        if len(s) < 4:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        needles.append(s)
    return needles


def _match_strings(strings: list[str], needles: list[str]) -> tuple[bool, str]:
    for s in strings:
        raw = html.unescape(s or '')
        variants = [raw, raw.replace('\\/', '/')]
        for variant in variants:
            low = variant.lower()
            for needle in needles:
                n = needle.lower()
                if n and n in low:
                    if 'sref=' in n:
                        return True, 'matched_full_share_url'
                    if '/share/' in n:
                        return True, 'matched_share_path'
                    return True, 'matched_public_payload'
    return False, 'share_link_not_found'


def _fetch_text(url: str, headers: dict[str, str]) -> tuple[bool, str, str]:
    try:
        resp = requests.get(url, headers=headers, timeout=12, allow_redirects=True)
    except Exception:
        return False, '', 'fetch_failed'
    if resp.status_code >= 400:
        return False, '', f'http_{resp.status_code}'
    body = html.unescape(resp.text or '')
    if not body:
        return False, '', 'empty_response'
    return True, body, 'ok'


def _extract_x_status_id(post_url: str) -> str:
    m = re.search(r'/status/(\d+)', post_url)
    return (m.group(1) if m else '').strip()


def _verify_x_post(post_url: str, attempt: dict, headers: dict[str, str]) -> tuple[bool, str]:
    needles = _share_needles(attempt)

    fetch_urls: list[tuple[str, str]] = [(post_url, 'x_public_html')]
    if 'x.com/' in post_url:
        fetch_urls.append((post_url.replace('://x.com/', '://twitter.com/'), 'twitter_public_html'))
    elif 'twitter.com/' in post_url:
        fetch_urls.append((post_url.replace('://twitter.com/', '://x.com/'), 'x_public_html_alt'))

    for url, label in fetch_urls:
        ok, body, detail = _fetch_text(url, headers)
        if ok:
            matched, reason = _match_strings([body], needles)
            if matched:
                return True, f'{label}:{reason}'

    status_id = _extract_x_status_id(post_url)
    if status_id:
        syndication_url = f'https://cdn.syndication.twimg.com/tweet-result?id={status_id}&lang=en'
        ok, body, detail = _fetch_text(syndication_url, headers)
        if ok:
            try:
                payload = json.loads(body)
            except Exception:
                payload = body
            matched, reason = _match_strings(_extract_strings(payload), needles)
            if matched:
                return True, f'x_syndication:{reason}'

        oembed_url = 'https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' + requests.utils.quote(post_url, safe='')
        ok, body, detail = _fetch_text(oembed_url, headers)
        if ok:
            try:
                payload = json.loads(body)
            except Exception:
                payload = body
            matched, reason = _match_strings(_extract_strings(payload), needles)
            if matched:
                return True, f'x_oembed:{reason}'

    return False, 'share_link_not_found'


def _verify_threads_post(post_url: str, attempt: dict, headers: dict[str, str]) -> tuple[bool, str]:
    needles = _share_needles(attempt)
    ok, body, detail = _fetch_text(post_url, headers)
    if ok:
        matched, reason = _match_strings([body], needles)
        if matched:
            return True, f'threads_public_html:{reason}'

    oembed_q = requests.utils.quote(post_url, safe='')
    for token_name in ('THREADS_OEMBED_ACCESS_TOKEN', 'THREADS_APP_ACCESS_TOKEN', 'META_APP_ACCESS_TOKEN'):
        token = (os.getenv(token_name) or '').strip()
        if not token:
            continue
        oembed_url = f'https://graph.threads.net/oembed?url={oembed_q}&access_token={requests.utils.quote(token, safe="")}'
        ok, body, detail = _fetch_text(oembed_url, headers)
        if ok:
            try:
                payload = json.loads(body)
            except Exception:
                payload = body
            matched, reason = _match_strings(_extract_strings(payload), needles)
            if matched:
                return True, f'threads_oembed:{reason}'

    return False, 'share_link_not_found'


def _verify_post_contains_share(post_url: str, attempt: dict) -> tuple[bool, str]:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    }
    platform = str(attempt.get('platform') or '').strip().lower()
    if platform == 'x':
        return _verify_x_post(post_url, attempt, headers)
    if platform == 'threads':
        return _verify_threads_post(post_url, attempt, headers)

    ok, body, detail = _fetch_text(post_url, headers)
    if not ok:
        return False, detail
    matched, reason = _match_strings([body], _share_needles(attempt))
    if matched:
        return True, reason
    return False, 'share_link_not_found'


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
