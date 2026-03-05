from __future__ import annotations
import re
import os

import urllib.parse
import json
import html
import hashlib
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Dict

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel

from ..db import db
from ..auth.deps import get_current_user_optional, require_user
from ..ingest import run_ingest_cycle, backfill_article_images
from ..scoring import compute_importance, compute_credibility
from ..translate import translate_feed_items

import threading
import asyncio

import requests
from bs4 import BeautifulSoup
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

import logging
import hashlib

log_video = logging.getLogger("news.video")
log_market = logging.getLogger("news.market")

# Small in-process cache for free market proxies (avoid rate limits)
_market_cache: dict[str, tuple[float, Any]] = {}

def _market_get_cached(key: str, ttl: int = 60) -> Any:
    try:
        now = time.time()
        hit = _market_cache.get(key)
        if hit and (now - float(hit[0])) < float(ttl):
            return hit[1]
    except Exception:
        return None
    return None

def _market_set_cached(key: str, value: Any) -> None:
    try:
        _market_cache[key] = (time.time(), value)
    except Exception:
        pass

router = APIRouter()

# ----------------------------
# Trending (🔥) server-side flag
# ----------------------------
# Deterministic so all users see the same result.
# Default rule (easy to explain):
#   - >= 4 outlets AND
#   - updated recently.
#
# Tweak these later if you add a real "popularity" signal.
TRENDING_MIN_OUTLETS = 4
# Window chosen to tolerate timezone/clock differences and still mean "actively updating".
TRENDING_WINDOW = timedelta(hours=6)

# "New" label window: for how long after creation a cluster is considered new.
NEW_WINDOW = timedelta(hours=6)

# If a cluster gets meaningfully updated soon after creation, show it as "Updated".
NEW_UPDATE_GRACE = timedelta(minutes=10)


def _compute_is_trending(cluster: dict[str, Any], sources_count: int) -> bool:
    """Compute a deterministic server-side 'trending' flag.

    v1 heuristic:
      - sources_count >= TRENDING_MIN_OUTLETS
      - cluster updated recently (updated_at or latest_published_at within TRENDING_WINDOW)

    Notes:
      - if timestamps are missing/invalid, fall back to outlets-only.
      - we treat naive timestamps as UTC.
    """
    if sources_count < TRENDING_MIN_OUTLETS:
        return False

    dt = _parse_dt(cluster.get("updated_at")) or _parse_dt(cluster.get("latest_published_at"))
    if not dt:
        return True

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    return (now - dt) <= TRENDING_WINDOW


def _compute_is_new(cluster: dict[str, Any]) -> bool:
    """Compute a server-side 'new' flag.

    Goal: a *newly created* cluster should show "New" instead of "Updated".
    We keep it "New" for a short window after creation, unless it has already
    been meaningfully updated.
    """
    created = _parse_dt(cluster.get("created_at"))
    if not created:
        return False

    updated = _parse_dt(cluster.get("updated_at"))

    # Normalize timezone
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if updated and updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    if (now - created) > NEW_WINDOW:
        return False

    # If the cluster was updated soon after creation, show it as "Updated".
    if updated and (updated - created) > NEW_UPDATE_GRACE:
        return False

    return True

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


def _feed_cache_key(
    *,
    interests: str,
    country: str,
    language: str,
    ui_lang: str,
    since: str | None,
    q: str | None,
    limit: int,
    bucket: int,
    variant: str,
) -> str:
    qn = (q or "").strip().lower()
    sn = (since or "").strip()
    inorm = (interests or "general").strip().lower()
    v = (variant or "guest").strip().lower()
    return f"v4|{bucket}|v={v}|i={inorm}|c={country}|l={language}|ui={ui_lang}|since={sn}|q={qn}|limit={limit}"

_REFRESH_STATE: dict[str, Any] = {"last_ts_by_ip": {}}
REFRESH_COOLDOWN_SECONDS = 180
FEED_KEEP_DAYS = 30


def _days_ago_iso(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.replace(microsecond=0).isoformat()


def _hours_ago_iso(hours: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.replace(microsecond=0).isoformat()


class Preferences(BaseModel):
    # All fields are optional-ish: the frontend sometimes saves only UI prefs.
    interests: list[str] = []
    country: str = "world"
    language: str = "en"
    # UI prefs (widgets layout, filters, thumbs) — stored per account to sync across devices.
    ui: Optional[Dict[str, Any]] = None


class FavoriteSync(BaseModel):
    ids: list[int] = []


def _safe_json_load(s: Optional[str]) -> Optional[Dict[str, Any]]:
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



def _parse_dt(value):
    """Parse datetime coming from sqlite (string) or already-a-datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    if not s:
        return None
    # Support both 'Z' and '+00:00'
    s = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _decorate_cluster_row(c: dict[str, Any], include_sources: bool = True) -> dict[str, Any]:
    cid = int(c["id"])

    # When an item is guest-locked we still want to show *non-sensitive*
    # metadata (primary source name + outlets count + image). We avoid
    # returning the full sources list (titles/urls) but we can safely
    # show aggregate info.
    sources: list[dict[str, Any]] = []
    primary_source: str | None = None
    event_image: str | None = None

    if include_sources:
        sources = db.get_cluster_sources(cid)
        primary_source = (sources[0].get("source_name") if sources else None)

        # choose event image: first non-empty article image_url
        for s in sources:
            u = (s.get("image_url") or "").strip()
            if u:
                event_image = u
                break
    else:
        brief = db.get_cluster_sources_brief(cid)
        primary_source = (brief.get("primary_source") or None)
        event_image = (brief.get("image_url") or None)

    latest_pub = db.get_cluster_latest_published_at(cid)

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
    credibility_explanation = (details or {}).get("summary") if details else "Score is not computed yet."
    credibility_factors = (details or {}).get("factors") if details else []

    # unique sources count by source_key if present else source_name
    # If sources list is not included (guest-locked), fall back to a brief aggregate.
    if sources:
        uniq = set()
        for s in sources:
            k = (s.get("source_key") or "").strip().lower()
            if not k:
                k = (s.get("source_name") or "unknown").strip().lower()
            uniq.add(k)
        sources_count = len(uniq)
    else:
        try:
            sources_count = int((db.get_cluster_sources_brief(cid) or {}).get("sources_count") or 0)
        except Exception:
            sources_count = 0

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
        "primary_source": primary_source,
        "sources_count": sources_count,
        "is_trending": _compute_is_trending(c, sources_count),
        "is_new": _compute_is_new(c),
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


def _redact_item_for_guest(it: dict[str, Any]) -> dict[str, Any]:
    """Redact details for guests (same paywall behavior as /api/news).

    /api/news/by_ids is used for deep-links (e.g. shared URLs). Without
    this, guests could bypass the paywall by requesting an item directly.
    """
    it = dict(it)
    it.pop("summary_facts", None)
    it.pop("summary_diffs", None)
    it.pop("summary_uncertainties", None)
    it["summary"] = ""
    it["credibility_explanation"] = "Create an account to view full details."
    it["guest_locked"] = True
    # Remove sources/details (keep count/metadata)
    it["sources"] = []
    return it


def _is_url(s: str) -> bool:
    try:
        ss = (s or "").strip().lower()
        return ss.startswith("http://") or ss.startswith("https://")
    except Exception:
        return False


_URL_DROP_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_name",
    "utm_reader",
    "utm_pubref",
    "fbclid",
    "gclid",
    "yclid",
    "mc_cid",
    "mc_eid",
}


def _normalize_url(u: str) -> str:
    try:
        u = (u or "").strip()
        if not u:
            return ""
        u = u.split("#", 1)[0]
        p = urllib.parse.urlsplit(u)
        if not p.scheme or not p.netloc:
            return u
        q = urllib.parse.parse_qsl(p.query, keep_blank_values=True)
        q2 = [
            (k, v)
            for (k, v) in q
            if k.lower() not in _URL_DROP_PARAMS and not k.lower().startswith("utm_")
        ]
        p2 = p._replace(query=urllib.parse.urlencode(q2, doseq=True))
        return urllib.parse.urlunsplit(p2)
    except Exception:
        return (u or "").strip().split("#", 1)[0]


def _url_hash(u: str) -> str:
    u = (u or "").strip().split("#", 1)[0]
    return hashlib.sha1(u.encode("utf-8")).hexdigest()


def _fetch_title_from_url(url: str) -> str:
    """Fetch a page title (og:title or <title>) for similarity search."""
    try:
        r = requests.get(
            url,
            timeout=8,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; CHECKnewsBot/1.0; +https://example.invalid)"
            },
        )
        if not r.ok:
            return ""
        html = r.text or ""
        soup = BeautifulSoup(html, "lxml")
        og = soup.find("meta", attrs={"property": "og:title"})
        if og and og.get("content"):
            return str(og.get("content")).strip()
        t = soup.find("title")
        if t and t.text:
            return str(t.text).strip()
        return ""
    except Exception:
        return ""


@router.get("/api/preferences")
def get_preferences(user=Depends(get_current_user_optional)) -> dict:
    """Return UI preferences.

    - Guests: defaults.
    - Authenticated users: stored per account in DB (persists across devices).
    """
    db.ensure_schema()

    defaults = {"interests": ["general"], "country": "world", "language": "en"}
    if not user:
        return {"status": "ok", "preferences": defaults, "scope": "guest"}

    row = db.get_user_preferences(int(user["id"]))
    if not row:
        return {"status": "ok", "preferences": defaults, "scope": "user"}

    try:
        interests = json.loads(row.get("interests_json") or "[]")
        if not isinstance(interests, list):
            interests = []
    except Exception:
        interests = []
    interests = [str(x).strip().lower() for x in interests if str(x).strip()]
    if not interests:
        interests = defaults["interests"]

    ui = _safe_json_load(row.get("ui_json"))
    prefs = {
        "interests": interests,
        "country": (row.get("country") or defaults["country"]),
        "language": (row.get("language") or defaults["language"]),
    }
    if ui:
        prefs["ui"] = ui
    return {"status": "ok", "preferences": prefs, "scope": "user"}


@router.post("/api/preferences")
def save_preferences(p: Preferences, user=Depends(require_user)) -> dict:
    db.ensure_schema()
    interests = [str(x).strip().lower() for x in (p.interests or []) if str(x).strip()]
    if not interests:
        interests = ["general"]
    interests = sorted(set(interests))

    country = (p.country or "world").strip().lower() or "world"
    language = (p.language or "en").strip().lower() or "en"

    uid = int(user["id"])
    # Preserve existing UI prefs unless the client explicitly sends `ui`.
    existing = db.get_user_preferences(uid)
    ui_json_existing = (existing or {}).get("ui_json")
    ui_json_new: Optional[str] = ui_json_existing
    if p.ui is not None:
        # Guardrail: keep UI prefs reasonably small (prevents abuse and DB bloat).
        try:
            ui_json_new = json.dumps(p.ui, ensure_ascii=False)
            if len(ui_json_new) > 50_000:
                raise ValueError("ui too large")
        except Exception:
            ui_json_new = ui_json_existing

    db.upsert_user_preferences(uid, json.dumps(interests), country, language, ui_json_new)
    saved = {"interests": interests, "country": country, "language": language}
    ui_obj = _safe_json_load(ui_json_new)
    if ui_obj:
        saved["ui"] = ui_obj
    return {"status": "ok", "saved": saved}



# NOTE: moved to src/app/routers/interests.py
# Keep this legacy endpoint only for debugging, to avoid route duplication.
@router.get("/api/interests/trending_v0")
async def get_trending_interests(
    country: str = "world",
    language: str = "all",
    ui_lang: str = "en",
    limit: int = 8,
) -> dict[str, Any]:
    """
    Dynamic interests ("Trending") for the UI chips.

    We compute a short list of topic-like labels from the most recent feed items.
    The goal is UX: compact chips like "Iran", "Trump", "Russia-Ukraine war" —
    not full headlines.

    This is intentionally lightweight (no heavy ML): it is deterministic inside the
    current feed snapshot bucket and cached the same way as /api/news.
    """
    try:
        db.ensure_schema()

        country = (country or "world").strip().lower()
        language = (language or "all").strip().lower()
        ui_lang = (ui_lang or "en").strip().lower()
        limit_n = max(2, min(12, int(limit)))

        bucket = _snapshot_bucket()
        cache_key = _feed_cache_key(
            interests="__trending__",
            country=country,
            language=language,
            ui_lang=ui_lang,
            since=None,
            q=None,
            limit=limit_n,
            bucket=bucket,
            variant="trending",
        )

        now = time.time()
        with _FEED_CACHE_LOCK:
            cached = _FEED_CACHE.get(cache_key)
            if cached and cached[0] > now:
                return cached[1]

        # Pull a broader slice and extract topic labels.
        clusters = db.query_clusters(
            interests=[],  # all interests
            country=country,
            language=language,
            since_iso=_hours_ago_iso(24),
            limit=240,
        )

        # ---- Topic extraction (fast heuristic) ----
        # We prefer: proper nouns, acronyms, hyphenated entities.
        # Keep labels compact: <= 22 chars (soft).
        stop = {
            "the","a","an","and","or","to","of","in","on","for","with","as","at","by","from",
            "after","before","over","under","into","about","amid","against","between",
            "what","why","how","we","you","they","their","our","your","his","her","its",
            "says","say","said","live","new","latest","update","updates","breaking",
            "report","reports","reported","watch","video","explainer",
        }

        def _clean(s: str) -> str:
            s = (s or "").replace("’", "'").replace("–", "-").replace("—", "-")
            s = re.sub(r"\s+", " ", s).strip()
            return s

        def _cands(title: str) -> list[str]:
            title = _clean(title)
            out: list[str] = []

            # Hyphen entities: Russia-Ukraine, US-Israel, etc.
            out += re.findall(r"\b[A-Z][A-Za-z]{1,}-[A-Z][A-Za-z]{1,}(?:-[A-Z][A-Za-z]{1,})?\b", title)

            # Acronyms: US, EU, NATO (avoid 1-letter)
            out += re.findall(r"\b[A-Z]{2,}\b", title)

            # Proper nouns (up to 3 words): "Donald Trump", "Iran", "European Union"
            out += re.findall(r"\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b", title)

            # Normalize and filter
            cleaned=[]
            for x in out:
                x=_clean(x)
                if not x: 
                    continue
                # drop very generic acronyms
                if x in {"US","U.S","UK","U.K"}:
                    x="US" if x.startswith("U") else x
                # remove common stopwords-only results
                parts=[p for p in re.split(r"[\s\-]+", x) if p]
                if len(parts)==1 and parts[0].lower() in stop:
                    continue
                if any(p.lower() in stop for p in parts) and len(parts)==1:
                    continue
                cleaned.append(x)
            return cleaned

        # Score by frequency * recency (decay)
        import math as _math
        scores: dict[str, float] = {}
        now_ts = time.time()

        for c in clusters:
            title = c.get("title") if isinstance(c, dict) else None
            if not title:
                continue
            # recency: use latest_published_at if present
            ts = None
            lp = c.get("latest_published_at") if isinstance(c, dict) else None
            if lp:
                try:
                    ts = datetime.fromisoformat(lp.replace("Z","+00:00")).timestamp()
                except Exception:
                    ts = None
            age_h = (now_ts - ts) / 3600.0 if ts else 12.0
            w = _math.exp(-age_h / 10.0)  # ~10h half-ish
            w *= 1.0 + 0.07 * float(c.get("sources_count") or 0)
            w *= 1.0 + 0.03 * float(c.get("importance") or 0)

            for cand in _cands(str(title)):
                # Skip too-long raw labels early
                if len(cand) > 38:
                    continue
                scores[cand] = scores.get(cand, 0.0) + w

        # Post-process: merge obvious variants and select compact labels
        def _norm_key(s: str) -> str:
            s = s.lower().strip()
            s = s.replace("u.s.", "us").replace("u.s", "us")
            s = re.sub(r"[^a-z0-9\s\-]+", "", s)
            s = re.sub(r"\s+", " ", s).strip()
            return s

        merged: dict[str, tuple[str, float]] = {}
        for label, sc in scores.items():
            k = _norm_key(label)
            if not k:
                continue
            if k in merged:
                # keep the prettier (shorter) display label
                old_label, old_sc = merged[k]
                best = label if (len(label) < len(old_label)) else old_label
                merged[k] = (best, old_sc + sc)
            else:
                merged[k] = (label, sc)

        ranked = sorted(merged.values(), key=lambda x: x[1], reverse=True)

        # Build final list:
        # - keep unique display labels
        # - enforce compact length by trimming with ellipsis
        out=[]
        used=set()
        for label, sc in ranked:
            lab=_clean(label)
            if not lab:
                continue
            # avoid duplicates like "Iran" repeated via other variants
            low=lab.lower()
            if low in used:
                continue
            # Very generic words to avoid as standalone
            if low in {"world","news","today","live","watch","updates"}:
                continue

            if len(lab) > 22:
                lab = lab[:21].rstrip() + "…"

            used.add(lab.lower())
            out.append({
                "label": lab,
                "score": round(float(sc), 3),
                # the client uses this as q=... (simple deterministic filter)
                "q": lab.replace("…",""),
            })
            if len(out) >= limit_n:
                break

        payload = {"status": "ok", "count": len(out), "items": out, "snapshot_bucket": bucket}

        with _FEED_CACHE_LOCK:
            _FEED_CACHE[cache_key] = (time.time() + FEED_SNAPSHOT_SECONDS, payload)

        return payload
    except Exception as e:
        print("[/api/interests/trending] failed:", repr(e))
        return {"status": "ok", "count": 0, "items": [], "error": str(e)}


@router.get("/api/news")
async def get_news(
    user=Depends(get_current_user_optional),
    ui_lang: str = "en",
    interests: str = "",
    country: str = "world",
    language: str = "all",
    since: Optional[str] = None,
    limit: int = 120,
    q: Optional[str] = None,
) -> dict[str, Any]:
    try:
        db.ensure_schema()

        interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
        interests_norm = ",".join(sorted(set(interests_list)))
        country = (country or "world").strip().lower()
        language = (language or "all").strip().lower()
        limit_n = max(1, min(400, int(limit)))

        # NOTE: bucketed snapshots make the feed deterministic across devices.
        # The helper is called _snapshot_bucket() in this file.
        bucket = _snapshot_bucket()
        ui_lang = (ui_lang or "en").strip().lower()

        cache_key = _feed_cache_key(
            interests=interests_norm,
            country=(country or "world").strip().lower(),
            language=(language or "en").strip().lower(),
            ui_lang=ui_lang,
            since=since,
            q=q,
            limit=limit_n,
            bucket=bucket,
            variant=("auth" if user else "guest"),
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

        # Paywall: guests get full details only for the first 3 items.
        is_guest = user is None
        items: list[dict[str, Any]] = []
        for idx, c in enumerate(clusters):
            if (not is_guest) or idx < 3:
                items.append(_decorate_cluster_row(c, include_sources=True))
            else:
                it = _decorate_cluster_row(c, include_sources=False)
                # redact details
                it.pop("summary_facts", None)
                it.pop("summary_diffs", None)
                it.pop("summary_uncertainties", None)
                it["summary"] = ""
                it["credibility_explanation"] = "Create an account to view full details."
                it["guest_locked"] = True
                items.append(it)

        cutoff = _days_ago_iso(FEED_KEEP_DAYS)
        items = [
            it
            for it in items
            if (it.get("latest_published_at") or it.get("updated_at") or "") >= cutoff
        ]

        if q and q.strip():
            qq_raw = q.strip().lower()

            # Search should be resilient for multi-word queries (e.g. trending 🔥 topics).
            # The old behavior required the *entire* phrase to be a substring, which often produced 0–1 results.
            # New behavior:
            #   - tokenize, drop tiny tokens and common stopwords
            #   - match if ANY remaining token appears in title or sources
            # This keeps Search useful while also making 🔥 topic filters behave like normal interests.
            stop = {
                "the","a","an","and","or","of","to","in","on","for","with","as","at","by","from",
                "what","who","will","inside","watch","how","why","so","far","live","updates","analysis",
            }
            tokens = [t for t in re.split(r"[^a-z0-9]+", qq_raw) if t and len(t) >= 2 and t not in stop]
            # Fallback: if nothing meaningful remains, keep the original substring behavior.
            if not tokens:
                tokens = [qq_raw]

            def hit(it: dict[str, Any]) -> bool:
                title = (it.get("title") or "").lower()
                if any(tok in title for tok in tokens):
                    return True
                for s in it.get("sources") or []:
                    st = ((s.get("title") or "").lower())
                    sn = ((s.get("source_name") or "").lower())
                    if any(tok in st for tok in tokens):
                        return True
                    if any(tok in sn for tok in tokens):
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

        # UI-language translation (content only). Never affects clustering/summary generation.
    # Translate for ANY ui_lang (including EN), but translate_feed_items will skip items
    # that are already in the UI language.
        if ui_lang and ui_lang.strip():
            try:
                items = await translate_feed_items(items, ui_lang)
            except Exception as e:
                print("[TRANSLATE] failed:", repr(e))
                # fail-open: keep originals
                pass


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
    except Exception as e:
        # Fail-open: don't take down the UI if something goes wrong.
        print("[/api/news] failed:", repr(e))
        return {"status": "ok", "count": 0, "items": [], "error": str(e)}

@router.get("/api/news/similar")
async def news_similar(
    url: str,
    user=Depends(get_current_user_optional),
    ui_lang: str = "en",
    interests: str = "",
    country: str = "world",
    language: str = "all",
    limit: int = 60,
) -> dict[str, Any]:
    """Find similar news in the feed by a pasted URL.

    The client can paste a link into Search. We fetch the page title and then
    rank current feed clusters by TF‑IDF cosine similarity (title + source titles).
    """
    db.ensure_schema()

    if not _is_url(url):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")

    norm_url = _normalize_url(url)
    q_title = _fetch_title_from_url(norm_url)
    if not q_title:
        # Fallback: use the URL itself as text (still allows matching domains/keywords)
        q_title = norm_url

    interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
    country = (country or "world").strip().lower()
    language = (language or "all").strip().lower()
    limit_n = max(1, min(200, int(limit)))
    ui_lang = (ui_lang or "en").strip().lower()

    # 1) Exact URL match → cluster_ids (if we already ingested this exact link)
    exact_ids: set[int] = set()
    try:
        h = _url_hash(norm_url)
        rows = db._fetchall(
            """
            SELECT DISTINCT ca.cluster_id AS cluster_id
            FROM articles a
            JOIN cluster_articles ca ON ca.article_id=a.id
            WHERE a.url_hash=?
            """,
            (h,),
        )
        exact_ids = {int(r["cluster_id"]) for r in rows if r.get("cluster_id") is not None}
    except Exception:
        exact_ids = set()

    # 2) Candidate pool: ignore current filters; search recent clusters across all topics/countries/languages
    since_iso = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
    clusters = db.query_clusters(
        interests=[],
        country="",
        language="all",
        since_iso=since_iso,
        limit=400,  # wider pool for similarity
    )

    # Decorate (respect guest paywall similarly to /api/news)
    is_guest = user is None
    decorated: list[dict[str, Any]] = []
    for idx, c in enumerate(clusters):
        if (not is_guest) or idx < 3:
            decorated.append(_decorate_cluster_row(c, include_sources=True))
        else:
            it = _decorate_cluster_row(c, include_sources=False)
            it.pop("summary_facts", None)
            it.pop("summary_diffs", None)
            it.pop("summary_uncertainties", None)
            it["summary"] = ""
            it["credibility_explanation"] = "Create an account to view full details."
            it["guest_locked"] = True
            decorated.append(it)

    def doc_text(it: dict[str, Any]) -> str:
        parts = [str(it.get("title") or "")]
        for s in (it.get("sources") or []):
            parts.append(str(s.get("title") or ""))
            parts.append(str(s.get("source_name") or ""))
        return " ".join([p for p in parts if p]).strip()

    docs = [doc_text(it) for it in decorated]
    query = str(q_title or "").strip()

    try:
        vec = TfidfVectorizer(ngram_range=(1, 2), max_features=4000)
        X = vec.fit_transform([query] + docs)
        sims = cosine_similarity(X[0:1], X[1:]).ravel()
    except Exception:
        sims = [0.0 for _ in docs]

    scored = []
    for it, s in zip(decorated, sims):
        try:
            score = float(s)
        except Exception:
            score = 0.0

        if int(it.get("cluster_id") or 0) in exact_ids:
            score = 1.0

        it["similarity"] = round(score, 4)
        scored.append((score, it))


    scored.sort(key=lambda x: x[0], reverse=True)

    # Keep only reasonably similar items (but always return at least a few)
    filtered = [it for score, it in scored if score >= 0.08]
    if len(filtered) < 5:
        filtered = [it for _, it in scored[: min(20, len(scored))]]

    filtered = filtered[:limit_n]

    # Translate content to ui_lang (same behavior as /api/news)
    if ui_lang:
        try:
            filtered = await translate_feed_items(filtered, ui_lang=ui_lang)
        except Exception:
            pass

    return {"status": "ok", "query_title": q_title, "count": len(filtered), "items": filtered}


@router.get("/api/news/by_ids")
async def news_by_ids(
    ids: str,
    user=Depends(get_current_user_optional),
    ui_lang: str = "en",
    interests: str = "",
    country: str = "world",
    language: str = "all",
) -> dict[str, Any]:
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
    items = [_decorate_cluster_row(r, include_sources=True) for r in rows]

    # Apply paywall for guests.
    # Guests may see FULL details only for the current feed's top-3 items.
    if user is None:
        interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
        country = (country or "world").strip().lower()
        language = (language or "all").strip().lower()

        top3 = db.query_clusters(
            interests=interests_list,
            country=country,
            language=language,
            since_iso=None,
            limit=3,
        )
        allow_ids = {int(r["id"]) for r in top3}

        redacted: list[dict[str, Any]] = []
        for it in items:
            try:
                cid = int(it.get("cluster_id") or it.get("id") or 0)
            except Exception:
                cid = 0

            if cid in allow_ids:
                redacted.append(it)
            else:
                redacted.append(_redact_item_for_guest(it))

        items = redacted

    pos = {cid: i for i, cid in enumerate(id_list)}
    items.sort(key=lambda x: pos.get(int(x["cluster_id"]), 10**9))

    if ui_lang and ui_lang.strip():
        try:
            items = await translate_feed_items(items, ui_lang)
        except Exception as e:
            print("[TRANSLATE] failed:", repr(e))
            pass



    return {"status": "ok", "count": len(items), "items": items}


class TrackingAck(BaseModel):
    ids: list[int]

@router.post("/api/tracking/ack")
def tracking_ack(payload: TrackingAck, user=Depends(require_user)) -> dict[str, Any]:
    """Acknowledge (reset) deltas for specific tracked clusters.

    The UI should call this when the user opens a card in Tracking, so the
    delta stays visible until the user actually checks it.
    """
    db.ensure_schema()

    ids = [int(x) for x in (payload.ids or []) if str(x).isdigit() or isinstance(x, int)]
    if not ids:
        return {"status": "ok", "updated": 0}

    clusters = db.get_clusters_by_ids(ids)
    now_iso = datetime.now(timezone.utc).isoformat()

    updates = []
    for c in clusters:
        cid = int(c["id"])
        # Mirror get_tracking score/sources_count calculation
        try:
            cur_score = int(c.get("credibility_score") or 0)
        except Exception:
            cur_score = 0
        try:
            cur_sources = int(c.get("sources_count") or 0)
        except Exception:
            cur_sources = 0
        updates.append((cid, cur_score, cur_sources, now_iso))

    db.update_user_favorites_seen_state(int(user["id"]), updates)
    return {"status": "ok", "updated": len(updates)}


@router.post("/api/favorites/sync")
def favorites_sync(payload: FavoriteSync, user=Depends(require_user)) -> dict[str, Any]:
    """Sync the full Tracking list (favorites) for the current user.

    Server-side enforces plan limits:
      - free: 3
      - pro: 30
      - analyst: unlimited

    The client should treat the server response as source of truth (e.g. if trimmed).
    """
    db.ensure_schema()
    uid = int(user["id"])

    # Determine plan (default: free)
    plan = "free"
    try:
        sub = db.get_user_subscription(uid)
        if sub and sub.get("plan"):
            plan = str(sub.get("plan") or "free").lower()
    except Exception:
        plan = "free"

    max_items: int | None
    if plan == "analyst":
        max_items = None  # unlimited
    elif plan == "pro":
        max_items = 30
    else:
        max_items = 3

    # Normalize + de-dupe while preserving order
    raw_ids = payload.ids or []
    seen: set[int] = set()
    norm: list[int] = []
    for x in raw_ids:
        try:
            n = int(x)
        except Exception:
            continue
        if n <= 0 or n in seen:
            continue
        seen.add(n)
        norm.append(n)

    trimmed = False
    applied = norm
    if max_items is not None and len(applied) > max_items:
        applied = applied[:max_items]
        trimmed = True

    db.upsert_user_favorites(uid, applied)

    return {
        "status": "ok",
        "count": len(applied),
        "max": max_items,  # null => unlimited
        "trimmed": trimmed,
        "ids": applied,
        "plan": plan,
    }



@router.get("/api/tracking")
def get_tracking(user=Depends(require_user)) -> dict[str, Any]:
    """Return user tracking cards (favorites).

    Deltas are computed vs favorites.last_seen_* (the previous "seen" snapshot).
    We also update last_seen_* for returned cards so next call shows changes since
    the last time the user opened Tracking.
    """
    db.ensure_schema()

    fav_rows = db.get_user_favorites_with_state(int(user["id"]))
    if not fav_rows:
        return {"status": "ok", "count": 0, "items": []}

    state_by_id = {r["cluster_id"]: r for r in fav_rows}
    ids = [r["cluster_id"] for r in fav_rows]

    clusters = db.get_clusters_by_ids(ids)
    items: list[dict[str, Any]] = []

    now_iso = datetime.now(timezone.utc).isoformat()

    updates = []
    for c in clusters:
        cid = c["id"]
        item = _decorate_cluster_row(c, include_sources=True)

        prev = state_by_id.get(cid) or {}
        prev_score = prev.get("last_seen_score")
        prev_sources = prev.get("last_seen_sources_count")

        # If never seen before: delta = 0 (no arrow)
        try:
            cur_score = int(item.get("credibility_score") or 0)
        except Exception:
            cur_score = 0
        try:
            cur_sources = int(item.get("sources_count") or 0)
        except Exception:
            cur_sources = 0

        delta_score = 0 if prev_score is None else int(cur_score - int(prev_score))
        delta_sources_count = 0 if prev_sources is None else int(cur_sources - int(prev_sources))

        item["delta_score"] = delta_score
        item["delta_sources_count"] = delta_sources_count

        items.append(item)
        updates.append((cid, cur_score, cur_sources, now_iso))

    # Keep order stable (newest first)
    def _sort_key(it: dict[str, Any]):
        return (it.get("latest_published_at") or "", it.get("cluster_id") or 0)

    items.sort(key=_sort_key, reverse=True)
    # Mark current state as "seen" so deltas reflect changes since the previous
    # time the user opened Tracking. (This replaces the old client-side ack.)
    if updates:
        db.update_user_favorites_seen_state(user["id"], updates)

    return {"status": "ok", "count": len(items), "items": items}


@router.get("/api/trust-history/{cluster_id}")
def get_trust_history(cluster_id: int, limit: int = 60, user=Depends(require_user)) -> dict[str, Any]:
    """Return server-side trust score history for a cluster.

    Used by Tracking UI chart. History is stored on the server so it is stable across devices.
    """
    db.ensure_schema()
    cid = int(cluster_id)
    rows = db.get_trust_history(cid, limit=limit)

    # If there is no server-side history yet (older clusters / before feature rollout),
    # seed it with the current snapshot so the UI can show at least 1 point.
    if not rows:
        try:
            score_row = db.get_score(cid) or {}
            cur_score = int(score_row.get("credibility_score") or 0)
        except Exception:
            cur_score = 0

        try:
            sources = db.get_cluster_sources(cid)
            uniq_sources = {
                (s.get("source_name") or "").strip().lower()
                for s in (sources or [])
                if (s.get("source_name") or "").strip()
            }
            cur_sources_count = len(uniq_sources)
        except Exception:
            cur_sources_count = 0

        try:
            db.record_trust_history_if_changed(cluster_id=cid, score=cur_score, sources_count=cur_sources_count)
        except Exception:
            pass

        rows = db.get_trust_history(cid, limit=limit)
    items: list[dict[str, Any]] = []
    for r in rows:
        try:
            ts = str(r.get("created_at") or "")
        except Exception:
            ts = ""
        try:
            score = int(r.get("score") or 0)
        except Exception:
            score = 0
        try:
            sc = int(r.get("sources_count") or 0)
        except Exception:
            sc = 0
        try:
            delta = int(r.get("sources_delta") or 0)
        except Exception:
            delta = 0

        items.append({
            "ts": ts,
            "score": score,
            "sources_count": sc,
            "sources_added": delta if delta > 0 else 0,
        })

    return {"status": "ok", "cluster_id": cid, "count": len(items), "items": items}

@router.get("/api/favorites")
def favorites_get(user=Depends(require_user)) -> dict[str, Any]:
    db.ensure_schema()
    ids = db.get_user_favorite_ids(int(user["id"]))
    return {"status": "ok", "ids": ids}


@router.post("/api/favorites/remove")
def favorites_remove(payload: FavoriteSync, user=Depends(require_user)) -> dict[str, Any]:
    db.ensure_schema()
    for cid in (payload.ids or [])[:200]:
        db.delete_user_favorite(int(user["id"]), int(cid))
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


@router.post("/api/news/backfill-images")
async def backfill_images(request: Request) -> dict[str, Any]:
    """Admin-only: backfill missing article images (fix older cards with no preview image)."""
    cfg = db.get_config()
    token_required = (cfg.refresh_token or "").strip()
    if not token_required:
        raise HTTPException(status_code=403, detail="Manual backfill is disabled")

    token = request.headers.get("x-refresh-token", "").strip()
    if token != token_required:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    payload = {}
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    days = payload.get("days", 365)
    limit = payload.get("limit", 400)
    budget = payload.get("budget", 60)
    stats = backfill_article_images(days=days, limit=limit, budget=budget)
    return {"status": "ok", "images": stats}


# -----------------
# Global email alerts (one toggle for all tracked events)
# -----------------
@router.get("/api/alerts/email")
def get_email_alerts(user=Depends(require_user)):
    enabled = db.get_user_email_alerts_enabled(int(user["id"]))
    return {"enabled": bool(enabled)}

@router.post("/api/alerts/email")
async def set_email_alerts(request: Request, user=Depends(require_user)):
    payload = {}
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    enabled = bool(payload.get("enabled"))
    db.set_user_email_alerts_enabled(int(user["id"]), enabled)
    return {"enabled": enabled}


# ----------------------------
# Video Report (PRO widget)
# ----------------------------


# ----------------------------
# Market proxies (FX / Crypto) — used by side widgets
# ----------------------------
@router.get("/api/market/fx")
def market_fx(base: str = "EUR", symbols: str = "USD,GBP,PLN,UAH"):
    """Simple FX proxy with short server cache (no keys).

    Primary: exchangerate.host (may occasionally be unavailable).
    Fallback: open.er-api.com (CORS-friendly free endpoint).
    """
    base_u = (base or "EUR").strip().upper()[:6]
    syms = [s.strip().upper() for s in (symbols or "").split(",") if s.strip()]
    syms = syms[:20]

    cache_key = f"fx:{base_u}:{','.join(syms)}"
    cached = _market_get_cached(cache_key, ttl=90)
    if cached is not None:
        return cached

    def _filter_rates(rates: dict) -> dict:
        if not rates:
            return {}
        if not syms:
            return dict(rates)
        out = {}
        for s in syms:
            if s in rates:
                out[s] = rates[s]
        return out

    # 1) exchangerate.host
    try:
        url = "https://api.exchangerate.host/latest"
        params = {"base": base_u, "symbols": ",".join(syms)}
        r = requests.get(url, params=params, timeout=8)
        if not r.ok:
            raise RuntimeError(f"fx_http_{r.status_code}")
        j = r.json() or {}
        rates = j.get("rates") or {}
        rates = _filter_rates(rates)
        if not rates:
            raise RuntimeError("fx_empty_rates")
        out = {"base": base_u, "rates": rates, "date": j.get("date"), "provider": "exchangerate.host"}
        _market_set_cached(cache_key, out)
        return out
    except Exception as e:
        log_market.warning("fx proxy primary failed: %s", e)

    # 2) Fallback provider: open.er-api.com
    try:
        url2 = f"https://open.er-api.com/v6/latest/{base_u}"
        r2 = requests.get(url2, timeout=8)
        if not r2.ok:
            raise RuntimeError(f"fx2_http_{r2.status_code}")
        j2 = r2.json() or {}
        # Provider uses `rates` or `conversion_rates`
        raw = j2.get("rates") or j2.get("conversion_rates") or {}
        # Normalize keys to upper
        rates2 = {str(k).upper(): v for k, v in (raw or {}).items()}
        rates2 = _filter_rates(rates2)
        if not rates2:
            raise RuntimeError("fx2_empty_rates")
        out2 = {"base": base_u, "rates": rates2, "date": j2.get("time_last_update_utc") or j2.get("time_last_update_unix"), "provider": "open.er-api.com"}
        _market_set_cached(cache_key, out2)
        return out2
    except Exception as e:
        log_market.warning("fx proxy fallback failed: %s", e)
        raise HTTPException(status_code=503, detail="fx_unavailable")


@router.get("/api/market/crypto")
def market_crypto(vs: str = "eur", coins: str = "bitcoin,ethereum"):
    """Simple crypto proxy via CoinGecko with short server cache."""
    vs_u = (vs or "eur").strip().lower()[:10]
    ids = [c.strip().lower() for c in (coins or "").split(",") if c.strip()]
    ids = ids[:20]
    cache_key = f"crypto:{vs_u}:{','.join(ids)}"
    cached = _market_get_cached(cache_key, ttl=45)
    if cached is not None:
        return cached

    url = "https://api.coingecko.com/api/v3/simple/price"
    params = {"ids": ",".join(ids), "vs_currencies": vs_u}
    try:
        r = requests.get(url, params=params, timeout=8)
        if not r.ok:
            raise RuntimeError(f"crypto_http_{r.status_code}")
        j = r.json() or {}
        out = {"vs": vs_u, "prices": j}
        _market_set_cached(cache_key, out)
        return out
    except Exception as e:
        log_market.warning("crypto proxy failed: %s", e)
        return {"vs": vs_u, "prices": {}, "detail": "crypto_unavailable"}

@router.get("/api/news/video")
@router.get("/video")  # backward-compatible
def news_video(
    request: Request,
    q: str = "",
    max_results: int = 5,
    cluster_id: Optional[int] = None,
    min_rating: Optional[int] = None,
    lang: str = "en",
):
    """
    Find a *likely* relevant news report video for a story headline.

    Strategy (server-side, so frontend stays simple):
    - Build several query variants that bias toward "official-ish" outlets (Reuters/BBC/AP/…)
    - Search YouTube multiple times (until we collect enough unique results)
    - Score results so major news channels appear first
    """
    q_raw = (q or "").strip()
    # Normalize query for cache-key stability (avoid cache misses due to spacing/HTML entities/casing).
    q_norm = html.unescape(q_raw)
    q_norm = ' '.join(q_norm.split()).strip().lower()
    if not q_raw:
        return {"items": [], "provider": "youtube", "detail": "missing_query"}

    # Enforce minimum story rating when cluster_id is provided (extra safety)    # Optional: block video search for low-rated clusters.
    # IMPORTANT: Only enforce this if a real numeric rating is stored in DB.
    try:
        if cluster_id and (min_rating is not None):
            meta = db.get_cluster_meta(int(cluster_id)) or {}
            score = meta.get("score") or meta.get("importance") or meta.get("credibility")
            if score is not None and float(score) < float(min_rating):
                return {"items": [], "provider": "youtube", "detail": "below_min_rating"}
    except Exception:
        pass


    # IMPORTANT:
    # Delegate to the shared video_report module so:
    # - cache keys are consistent (prefetch warms the same cache that the endpoint reads)
    # - stale-cache fallback works when quota is exhausted
    # - response includes meta.api_calls / quota_units for debugging
    from ..video_report import get_video_report

    try:
        cid_norm = int(cluster_id) if cluster_id else None
    except Exception:
        cid_norm = None

    limit = max(1, min(int(max_results or 5), 10))
    return get_video_report(q_raw=q_raw, lang=lang, cluster_id=cid_norm, max_results=limit)