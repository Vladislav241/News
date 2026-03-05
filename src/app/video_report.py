from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any, Optional

import requests

from .db import db


# A lightweight list of "major outlet" hints to bias rankings
OUTLET_HINTS = [
    "reuters", "associated press", "ap news", "bbc", "cnn", "al jazeera", "dw news",
    "sky news", "france 24", "euronews", "cbs news", "abc news", "nbc news",
    "pbs newshour", "the guardian", "washington post", "the telegraph",
]


def _normalize_lang(lang: str) -> str:
    try:
        return (lang or "en").strip().lower()[:10] or "en"
    except Exception:
        return "en"


def _cache_key_for(q_raw: str, lang_norm: str, cluster_id: int | None) -> str:
    # Cluster-level key massively increases hit rate (one lookup per story cluster).
    if cluster_id and int(cluster_id) > 0:
        basis = f"yt:v3:{lang_norm}:cid:{int(cluster_id)}"
    else:
        basis = f"yt:v3:{lang_norm}:q:{(q_raw or '').lower().strip()}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def _score_item(title: str, channel: str) -> int:
    t = (title or "").lower()
    c = (channel or "").lower()

    score = 0
    for nm in OUTLET_HINTS:
        if nm in c:
            score += 20
            break

    if any(k in t for k in ["report", "explained", "breaking", "latest", "analysis", "update"]):
        score += 6
    if "interview" in t:
        score += 2

    # Penalize obvious non-news content
    if any(k in c for k in ["gaming", "clips", "highlights", "reaction", "compilation"]):
        score -= 8

    return score


def _youtube_search(
    key: str,
    q: str,
    lang_norm: str,
    max_results: int,
    page_token: str | None = None,
) -> tuple[dict[str, Any] | None, int, str | None]:
    """
    Returns: (json_or_none, status_code, error_reason)

    Notes:
    - YouTube Data API v3 'search.list' typically costs 100 quota units per call.
    - We keep error_reason short and deterministic for caching/telemetry.
    """
    params = {
        "part": "snippet",
        "q": q,
        "type": "video",
        "maxResults": min(10, max(1, int(max_results))),
        "key": key,
        "safeSearch": "strict",
    }
    # Bias results by language (best-effort).
    if lang_norm:
        params["relevanceLanguage"] = lang_norm
    if page_token:
        params["pageToken"] = page_token

    try:
        r = requests.get("https://www.googleapis.com/youtube/v3/search", params=params, timeout=8)
    except Exception:
        return None, 0, "request_failed"

    if r.status_code != 200:
        reason = None
        try:
            j = r.json()
            reason = ((j.get("error") or {}).get("errors") or [{}])[0].get("reason")
        except Exception:
            reason = None

        # Normalize a few common reasons.
        if r.status_code == 403 and reason:
            # e.g. quotaExceeded, dailyLimitExceeded, rateLimitExceeded, accessNotConfigured
            return None, int(r.status_code), f"forbidden:{reason}"
        if r.status_code == 400 and reason:
            return None, int(r.status_code), f"bad_request:{reason}"
        if r.status_code == 401:
            return None, int(r.status_code), "unauthorized"
        return None, int(r.status_code), "http_error"

    try:
        return r.json(), int(r.status_code), None
    except Exception:
        return None, int(r.status_code), "bad_json"


def _build_queries(q_raw: str) -> list[str]:
    q = (q_raw or "").strip()
    if not q:
        return []
    # Deterministic variants.
    # IMPORTANT: YouTube `search.list` is quota-expensive, so keep this small.
    # You can override the cap via env YT_VIDEO_MAX_SEARCH_CALLS.
    return [
        f"{q} report",
        f"{q} news report",
        f"{q} explained",
        f"{q} BBC",
        f"{q} Reuters",
    ]


def fetch_video_report_from_youtube(q_raw: str, lang: str = "en", max_results: int = 5) -> dict[str, Any]:
    key = os.getenv("YOUTUBE_API_KEY", "").strip()
    lang_norm = _normalize_lang(lang)

    queries = _build_queries(q_raw)
    if not queries:
        return {"items": [], "provider": "youtube", "detail": "missing_query", "meta": {"api_calls": 0, "quota_units": 0}}

    if not key:
        # Important: allow stale cache fallback upstream.
        return {"items": [], "provider": "youtube", "detail": "missing_YOUTUBE_API_KEY", "meta": {"api_calls": 0, "quota_units": 0}}

    seen: set[str] = set()
    items: list[dict[str, Any]] = []

    try:
        max_calls = int(os.getenv("YT_VIDEO_MAX_SEARCH_CALLS", "2"))
    except Exception:
        max_calls = 2
    max_calls = max(1, min(int(max_calls), 10))

    api_calls = 0
    last_err: str | None = None
    executed_queries = queries[:max_calls]

    for q in executed_queries:
        data, status, err = _youtube_search(key, q=q, lang_norm=lang_norm, max_results=max_results)
        api_calls += 1
        if err:
            last_err = err if (status or err) else last_err
            # If quota/rate limit hit, stop early (no point burning more).
            if err.startswith("forbidden:quota") or "dailyLimitExceeded" in err or "rateLimitExceeded" in err:
                break
            continue
        if not data:
            continue

        for it in (data.get("items") or []):
            vid = ((it.get("id") or {}) if isinstance(it.get("id"), dict) else {}).get("videoId") or None
            if not vid or vid in seen:
                continue
            seen.add(vid)

            sn = it.get("snippet") or {}
            title = sn.get("title") or ""
            channel = sn.get("channelTitle") or ""
            thumb = ((sn.get("thumbnails") or {}).get("medium") or {}).get("url") or None

            items.append(
                {
                    "video_id": vid,
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "title": title,
                    "channel": channel,
                    "thumbnail": thumb,
                    "score": _score_item(title, channel),
                    "published_at": sn.get("publishedAt"),
                }
            )
            if len(items) >= int(max_results):
                break
        if len(items) >= int(max_results):
            break

    items.sort(key=lambda x: int(x.get("score") or 0), reverse=True)

    # Rough quota estimate: search.list is typically 100 units/call.
    quota_units = int(api_calls) * 100

    if items:
        detail = "ok"
    else:
        detail = last_err or "no_results"

    return {
        "items": items,
        "provider": "youtube",
        "detail": detail,
        "meta": {
            "api_calls": int(api_calls),
            "quota_units": int(quota_units),
            "queries": executed_queries[: min(len(executed_queries), 5)],
        },
    }


def get_video_report(
    q_raw: str,
    lang: str = "en",
    cluster_id: Optional[int] = None,
    max_results: int = 5,
    ttl_seconds: Optional[int] = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Cluster-level cached video report.

    Goals:
    - Shared DB cache across users (one user's click warms cache for everyone).
    - Prefer cluster_id-based key for a much higher hit rate.
    - If YouTube quota is exhausted (or the API is temporarily unavailable),
      fall back to a previously cached result (even if stale/expired).
    """
    q_raw = (q_raw or "").strip()
    if not q_raw:
        return {"items": [], "provider": "youtube", "detail": "missing_query", "meta": {"api_calls": 0, "quota_units": 0}}

    lang_norm = _normalize_lang(lang)

    if ttl_seconds is None:
        try:
            ttl_h = int(os.getenv("YT_VIDEO_TTL_HOURS", "24"))
        except Exception:
            ttl_h = 24
        ttl_seconds = max(3600, ttl_h * 3600)

    cache_key = _cache_key_for(q_raw=q_raw, lang_norm=lang_norm, cluster_id=cluster_id)

    # 1) Fresh cache
    if not force_refresh:
        try:
            hit = db.get_video_report_cache(cache_key)
            if hit and hit.get("payload_json"):
                payload = json.loads(hit["payload_json"]) if isinstance(hit["payload_json"], str) else hit["payload_json"]
                if isinstance(payload, dict):
                    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
                    payload["detail"] = payload.get("detail") or "cache_hit"
                    payload["cache"] = "hit"
                    payload["meta"] = {
                        **meta,
                        "api_calls": 0,
                        "quota_units": 0,
                        "quota_units_saved": int(meta.get("quota_units") or 0),
                    }
                    return payload
        except Exception:
            pass

    # 2) Miss -> attempt fetch
    payload = fetch_video_report_from_youtube(q_raw=q_raw, lang=lang_norm, max_results=max_results)

    # 3) If fetch failed / empty due to quota/API issues, try stale cache fallback
    should_try_stale = not (payload.get("items") or [])
    if should_try_stale:
        try:
            stale = db.get_video_report_cache_stale(cache_key)
            if stale and stale.get("payload_json"):
                cached = json.loads(stale["payload_json"]) if isinstance(stale["payload_json"], str) else stale["payload_json"]
                if isinstance(cached, dict) and (cached.get("items") or []):
                    meta = cached.get("meta") if isinstance(cached.get("meta"), dict) else {}
                    cached["cache"] = "stale"
                    cached["detail"] = f"stale_cache_fallback:{payload.get('detail') or 'error'}"
                    cached["meta"] = {
                        **meta,
                        "api_calls": 0,
                        "quota_units": 0,
                        "quota_units_saved": int(meta.get("quota_units") or 0),
                        "stale_expires_at": stale.get("expires_at"),
                        "stale_created_at": stale.get("created_at"),
                    }
                    return cached
        except Exception:
            pass

    # 4) Store miss result (even empty, but shorter TTL for errors)
    try:
        ttl_ok = int(ttl_seconds)
    except Exception:
        ttl_ok = 24 * 3600
    try:
        ttl_empty = int(os.getenv("YT_VIDEO_TTL_EMPTY_SECONDS", "3600"))  # 1h default
    except Exception:
        ttl_empty = 3600

    ttl_use = ttl_ok if (payload.get("items") or []) else ttl_empty

    try:
        db.set_video_report_cache(
            cache_key=cache_key,
            q=q_raw,
            lang=lang_norm,
            payload_json=json.dumps(payload, ensure_ascii=False),
            ttl_seconds=int(ttl_use),
        )
    except Exception:
        pass

    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    payload["cache"] = "miss"
    payload["meta"] = {**meta, "quota_units_saved": 0}
    return payload


def prefetch_video_reports_for_clusters(
    cluster_ids: list[int],
    lang_fallback: str = "en",
    max_prefetch: int = 6,
    max_results: int = 5,
) -> dict[str, Any]:
    """Best-effort prefetch: warms cache for top clusters during ingest."""
    key = os.getenv("YOUTUBE_API_KEY", "").strip()
    if not key:
        return {"prefetched": 0, "detail": "missing_YOUTUBE_API_KEY"}

    done = 0
    for cid in cluster_ids[: max(0, int(max_prefetch))]:
        try:
            meta = db.get_cluster_meta(int(cid)) or {}
            title = (meta.get("title") or "").strip()
            if not title:
                continue
            lang = (meta.get("language") or lang_fallback or "en").strip().lower()
            # We call get_video_report(), which will no-op if cache exists (hit).
            res = get_video_report(q_raw=title, lang=lang, cluster_id=int(cid), max_results=max_results)
            if res.get("cache") == "miss":
                done += 1
        except Exception:
            continue

    return {"prefetched": done, "detail": "ok"}
