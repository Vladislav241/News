from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db import db
from ..ingest import run_ingest_cycle
from ..scoring import compute_importance, compute_credibility

import threading

router = APIRouter()

# Cache {cache_key: (expires_at_epoch, payload_dict)}
_FEED_CACHE: dict[str, tuple[float, dict]] = {}
_FEED_CACHE_LOCK = threading.Lock()

# How long one "snapshot" lives. Everyone requesting the same key within
# this window gets identical ordering and identical values.
FEED_SNAPSHOT_SECONDS = 60


def _snapshot_bucket(now: float | None = None, window: int = FEED_SNAPSHOT_SECONDS) -> int:
    """Return a stable time bucket index for snapshotting."""
    if now is None:
        now = time.time()
    return int(now // window)


# Backward-compatible alias: some earlier revisions referenced this name.
def _current_snapshot_bucket() -> int:
    return _snapshot_bucket()


def _feed_cache_key(
    *,
    interests: str,
    country: str,
    language: str,
    since: str | None,
    q: str | None,
    limit: int,
    bucket: int,
) -> str:
    qn = (q or "").strip().lower()
    sn = (since or "").strip()
    inorm = (interests or "general").strip().lower()
    return f"v2|{bucket}|i={inorm}|c={country}|l={language}|since={sn}|q={qn}|limit={limit}"

_REFRESH_STATE: dict[str, Any] = {"last_ts_by_ip": {}}
REFRESH_COOLDOWN_SECONDS = 180
FEED_KEEP_DAYS = 30


def _days_ago_iso(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.replace(microsecond=0).isoformat()


class Preferences(BaseModel):
    interests: list[str] = []
    country: str = "world"
    language: str = "en"


class FavoriteSync(BaseModel):
    device_id: str
    ids: list[int] = []


def _safe_json_load(s: str | None) -> dict[str, Any] | None:
    try:
        if not s:
            return None
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _build_diff_proofs(
    diffs: list[dict[str, Any]],
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    # pick most recent entry per source_name (display)
    by_name: dict[str, dict[str, Any]] = {}
    for s in sources or []:
        nm = (s.get("source_name") or "").strip()
        if not nm:
            continue
        if nm not in by_name:
            by_name[nm] = {
                "source_name": nm,
                "source_key": s.get("source_key"),
                "title": s.get("title"),
                "url": s.get("url"),
                "published_at": s.get("published_at"),
            }

    out: list[dict[str, Any]] = []
    for d in (diffs or [])[:6]:
        if not isinstance(d, dict):
            continue
        srcs = d.get("sources")
        diff_text = d.get("difference")
        if not isinstance(srcs, list) or len(srcs) < 2:
            continue
        if not isinstance(diff_text, str) or not diff_text.strip():
            continue
        a_name = str(srcs[0]).strip()
        b_name = str(srcs[1]).strip()
        out.append(
            {
                "sources": [a_name, b_name],
                "difference": diff_text.strip(),
                "a": by_name.get(a_name),
                "b": by_name.get(b_name),
            }
        )
    return out


def _decorate_cluster_row(c: dict[str, Any], include_sources: bool = True) -> dict[str, Any]:
    cid = int(c["id"])

    sources = db.get_cluster_sources(cid) if include_sources else []
    latest_pub = db.get_cluster_latest_published_at(cid)

    # choose event image: first non-empty article image_url
    event_image = None
    for s in sources:
        u = (s.get("image_url") or "").strip()
        if u:
            event_image = u
            break

    details = None
    if c.get("score_details_json"):
        try:
            details = json.loads(c["score_details_json"])
        except Exception:
            details = None

    # If the cluster doesn't have a stored score yet, compute it on the fly
    # so the UI never shows long runs of "0/100" (common right after ingest
    # or after a fresh deploy on Render).
    if details is None and sources:
        try:
            details = compute_credibility(sources)
        except Exception:
            details = None

    credibility_score = int(
        c.get("credibility_score")
        or ((details or {}).get("final_score") if details else 0)
        or 0
    )
    credibility_explanation = (details or {}).get("summary") if details else "Скоринг ещё не рассчитан."
    credibility_factors = (details or {}).get("factors") if details else []

    # unique sources count by source_key if present else source_name
    uniq = set()
    for s in sources:
        k = (s.get("source_key") or "").strip().lower()
        if not k:
            k = (s.get("source_name") or "unknown").strip().lower()
        uniq.add(k)
    sources_count = len(uniq)

    importance = compute_importance(
        cluster_updated_at_iso=(c.get("updated_at") or ""),
        sources_count=sources_count,
        latest_published_at_iso=latest_pub,
    )

    # summary JSON first
    summary_json = _safe_json_load(c.get("summary_json"))
    summary_brief = ""
    summary_facts: list[str] = []
    summary_uncertainties: list[str] = []
    summary_diffs: list[dict[str, Any]] = []

    if summary_json:
        summary_brief = (summary_json.get("brief") or "").strip()
        if isinstance(summary_json.get("key_facts"), list):
            summary_facts = [str(x).strip() for x in summary_json["key_facts"] if str(x).strip()][:6]
        if isinstance(summary_json.get("uncertainties"), list):
            summary_uncertainties = [str(x).strip() for x in summary_json["uncertainties"] if str(x).strip()][:4]
        if isinstance(summary_json.get("diffs"), list):
            diffs_raw = [x for x in summary_json["diffs"] if isinstance(x, dict)]
            summary_diffs = _build_diff_proofs(diffs_raw, sources)

    # fallback legacy: summary_text as brief
    if not summary_brief:
        summary_brief = (c.get("summary_text") or "").strip()

    payload: dict[str, Any] = {
        "cluster_id": cid,
        "event_id": cid,
        "title": c.get("title") or "Event",
        "topic": c.get("topic") or "general",
        "country": c.get("country") or "world",
        "language": c.get("language") or "en",
        "created_at": c.get("created_at"),
        "updated_at": c.get("updated_at"),
        "latest_published_at": latest_pub,
        "image": event_image,
        "sources_count": sources_count,
        "credibility_score": credibility_score,
        "credibility_explanation": credibility_explanation,
        "credibility_factors": credibility_factors,
        "importance": importance,
        # summary (structured)
        "summary": summary_brief,
        "summary_facts": summary_facts,
        "summary_diffs": summary_diffs,
        "summary_uncertainties": summary_uncertainties,
        # status/meta
        "summary_status": c.get("summary_status") or "none",
        "summary_model": c.get("summary_model"),
        "summary_raw": (c.get("summary_raw_text") or ""),
    }

    if include_sources:
        payload["sources"] = [
            {
                "source_name": s.get("source_name"),
                "source_key": s.get("source_key"),
                "title": s.get("title"),
                "url": s.get("url"),
                "published_at": s.get("published_at"),
                "image_url": s.get("image_url"),
            }
            for s in sources
        ]

    return payload


@router.get("/api/preferences")
def get_preferences() -> dict:
    return {"status": "ok", "note": "preferences are stored on frontend (localStorage) for now"}


@router.post("/api/preferences")
def save_preferences(p: Preferences) -> dict:
    return {"status": "ok", "saved": p.model_dump()}


@router.get("/api/news")
def get_news(
    interests: str = "",
    country: str = "world",
    language: str = "en",
    since: Optional[str] = None,
    limit: int = 120,
    q: Optional[str] = None,
) -> dict[str, Any]:
    db.ensure_schema()

    interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
    interests_norm = ",".join(sorted(set(interests_list)))
    country = (country or "world").strip().lower()
    language = (language or "en").strip().lower()
    limit_n = max(1, min(400, int(limit)))

    bucket = _current_snapshot_bucket()
    cache_key = _feed_cache_key(
        interests=interests_norm,
        country=(country or "world").strip().lower(),
        language=(language or "en").strip().lower(),
        since=since,
        q=q,
        limit=limit_n,
        bucket=bucket,
    )

    now = time.time()
    with _FEED_CACHE_LOCK:
        cached = _FEED_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]

    clusters = db.query_clusters(
        interests=interests_list,
        country=country,
        language=language,
        since_iso=since,
        limit=limit_n,
    )

    items = [_decorate_cluster_row(c) for c in clusters]

    cutoff = _days_ago_iso(FEED_KEEP_DAYS)
    items = [
        it
        for it in items
        if (it.get("latest_published_at") or it.get("updated_at") or "") >= cutoff
    ]

    if q and q.strip():
        qq = q.strip().lower()

        def hit(it: dict[str, Any]) -> bool:
            if qq in (it.get("title") or "").lower():
                return True
            for s in it.get("sources") or []:
                if qq in ((s.get("title") or "").lower()):
                    return True
                if qq in ((s.get("source_name") or "").lower()):
                    return True
            return False

        items = [it for it in items if hit(it)]

    items.sort(
        key=lambda x: (
            x.get("latest_published_at") or "",
            int(x.get("importance") or 0),
            int(x.get("credibility_score") or 0),
            int(x.get("sources_count") or 0),
            int(x.get("cluster_id") or 0),
        ),
        reverse=True,
    )

    snapshot_at = datetime.fromtimestamp(
        bucket * FEED_SNAPSHOT_SECONDS, tz=timezone.utc
    ).isoformat()

    payload = {
        "status": "ok",
        "count": len(items),
        "items": items,
        "cutoff": cutoff,
        "snapshot_bucket": bucket,
        "snapshot_at": snapshot_at,
    }

    with _FEED_CACHE_LOCK:
        _FEED_CACHE[cache_key] = (time.time() + FEED_SNAPSHOT_SECONDS, payload)

    return payload


@router.get("/api/news/by_ids")
def news_by_ids(ids: str) -> dict[str, Any]:
    db.ensure_schema()

    id_list: list[int] = []
    for part in (ids or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            id_list.append(int(part))
        except Exception:
            continue

    id_list = list(dict.fromkeys(id_list))[:200]
    rows = db.get_clusters_by_ids(id_list)
    items = [_decorate_cluster_row(r) for r in rows]

    pos = {cid: i for i, cid in enumerate(id_list)}
    items.sort(key=lambda x: pos.get(int(x["cluster_id"]), 10**9))

    return {"status": "ok", "count": len(items), "items": items}


@router.post("/api/favorites/sync")
def favorites_sync(payload: FavoriteSync) -> dict[str, Any]:
    db.ensure_schema()
    db.upsert_favorites(payload.device_id, payload.ids)
    return {"status": "ok", "count": len(payload.ids)}


@router.get("/api/favorites")
def favorites_get(device_id: str) -> dict[str, Any]:
    db.ensure_schema()
    ids = db.get_favorite_ids(device_id)
    return {"status": "ok", "ids": ids}


@router.post("/api/favorites/remove")
def favorites_remove(payload: FavoriteSync) -> dict[str, Any]:
    db.ensure_schema()
    for cid in (payload.ids or [])[:200]:
        db.delete_favorite(payload.device_id, cid)
    return {"status": "ok"}


@router.post("/api/news/refresh")
def refresh(request: Request) -> dict[str, Any]:
    """Manual ingest trigger.

    In production we DO NOT want end-users to trigger ingestion (rate limits, thundering herd).
    The server runs ingestion automatically (see main.py). Keep this endpoint only for admin use.
    """
    cfg = db.get_config()
    token_required = (cfg.refresh_token or "").strip()
    if not token_required:
        # Disabled unless you explicitly set REFRESH_TOKEN in config/env.
        raise HTTPException(status_code=403, detail="Manual refresh is disabled")

    token = request.headers.get("x-refresh-token", "").strip()
    if token != token_required:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    last = _REFRESH_STATE["last_ts_by_ip"].get(client_ip, 0.0)
    remaining = int(REFRESH_COOLDOWN_SECONDS - (now - last))

    if remaining > 0:
        raise HTTPException(
            status_code=429,
            detail={
                "message": "Refresh cooldown. Try later.",
                "retry_after_seconds": remaining,
            },
            headers={"Retry-After": str(remaining)},
        )

    _REFRESH_STATE["last_ts_by_ip"][client_ip] = now
    stats = run_ingest_cycle()
    return {"status": "ok", "ingest": stats, "cooldown_seconds": REFRESH_COOLDOWN_SECONDS}
