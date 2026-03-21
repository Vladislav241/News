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

from fastapi import APIRouter, HTTPException, Request, Depends, BackgroundTasks, File, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from ..db import db, _normalize_interest_selection
from ..auth.deps import get_current_user_optional, require_user
from ..ingest import run_ingest_cycle, backfill_article_images, _should_refresh_summary
from ..scoring import compute_importance, compute_credibility
from ..translate import translate_feed_items
from ..ai import extract_visual_search_signal, _extract_brief_from_text
from ..runtime import background_tasks_disabled

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


def _market_get_stale(key: str, max_age: int = 900) -> Any:
    try:
        now = time.time()
        hit = _market_cache.get(key)
        if hit and (now - float(hit[0])) < float(max_age):
            return hit[1]
    except Exception:
        return None
    return None

router = APIRouter()

_SUMMARY_BACKFILL_LOCK = threading.Lock()
_SUMMARY_BACKFILL_INFLIGHT: set[int] = set()

def _should_queue_summary_backfill(row: dict[str, Any]) -> bool:
    try:
        cid = int(row.get("id") or row.get("cluster_id") or 0)
    except Exception:
        return False
    if cid <= 0:
        return False

    status = str(row.get("summary_status") or "").strip().lower()
    text = str(row.get("summary_text") or "").strip()
    try:
        score = int(row.get("credibility_score") or 0)
    except Exception:
        score = 0

    try:
        sources_count = int(row.get("sources_count") or 0)
    except Exception:
        sources_count = 0

    if text and status == "success":
        return False
    if status in {"skipped", "locked"}:
        return False
    if status == "pending":
        return False
    if score < 70:
        return False
    if sources_count < 2:
        return False
    return True

def _backfill_summaries_for_cluster_ids(cluster_ids: list[int]) -> None:
    if not cluster_ids:
        return

    try:
        summary_model = (os.getenv("OPENAI_SUMMARY_MODEL", "").strip() or os.getenv("OPENAI_MODEL", "gpt-4.1-mini"))
    except Exception:
        summary_model = "gpt-4.1-mini"

    try:
        min_interval_seconds = int(os.getenv("SUMMARY_REGEN_MIN_INTERVAL_SECONDS", str(30 * 60)) or (30 * 60))
    except Exception:
        min_interval_seconds = 30 * 60

    try:
        from ..ai import summarize_cluster, _extract_brief_from_text

        for cid in cluster_ids:
            try:
                sources = db.get_cluster_sources(int(cid))
                should_run, _reason, source_fp, source_count = _should_refresh_summary(
                    cluster_id=int(cid),
                    sources=sources,
                    min_interval_seconds=min_interval_seconds,
                )
                if not should_run:
                    continue

                meta = db.get_cluster_meta(int(cid)) or {}
                title = (meta.get("title") or "Event").strip()
                lang = (meta.get("language") or "en").strip().lower()
                brief, summary_json, status, raw_text = summarize_cluster(
                    cluster_title=title,
                    sources=sources,
                    lang=lang,
                    model=summary_model,
                )
                db.upsert_summary(
                    cluster_id=int(cid),
                    summary_text=brief,
                    summary_json=summary_json,
                    raw_text=raw_text,
                    model=summary_model,
                    status=status,
                    source_fingerprint=source_fp,
                    source_count=source_count,
                )
            except Exception:
                log_video.exception("summary backfill failed for cluster_id=%s", cid)
    finally:
        with _SUMMARY_BACKFILL_LOCK:
            for cid in cluster_ids:
                _SUMMARY_BACKFILL_INFLIGHT.discard(int(cid))

def _queue_missing_summaries(rows: list[dict[str, Any]], background_tasks: BackgroundTasks | None, max_jobs: int = 4) -> None:
    if background_tasks is None or background_tasks_disabled():
        return

    picked: list[int] = []
    for row in rows:
        if len(picked) >= max_jobs:
            break
        if not _should_queue_summary_backfill(row):
            continue
        try:
            cid = int(row.get("id") or row.get("cluster_id") or 0)
        except Exception:
            continue
        if cid <= 0:
            continue
        with _SUMMARY_BACKFILL_LOCK:
            if cid in _SUMMARY_BACKFILL_INFLIGHT:
                continue
            _SUMMARY_BACKFILL_INFLIGHT.add(cid)
        try:
            existing = db.get_summary(cid) or {}
            db.upsert_summary(
                cluster_id=cid,
                summary_text=existing.get("summary_text"),
                summary_json=existing.get("summary_json"),
                raw_text=existing.get("raw_text"),
                model=(existing.get("model") or os.getenv("OPENAI_SUMMARY_MODEL", "") or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")),
                status="pending",
                source_fingerprint=existing.get("source_fingerprint"),
                source_count=int(existing.get("source_count") or 0),
            )
        except Exception:
            pass
        picked.append(cid)

    if picked:
        background_tasks.add_task(_backfill_summaries_for_cluster_ids, picked)

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
    if sources_count < TRENDING_MIN_OUTLETS:
        return False

    dt = _parse_dt(cluster.get("updated_at")) or _parse_dt(cluster.get("latest_published_at"))
    if not dt:
        return True

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    return (now - dt) <= TRENDING_WINDOW


# ----------------------------
# Event map helpers
# ----------------------------
_MAP_PLACE_INDEX: list[dict[str, Any]] = [
    {"key": "tehran", "label": "Tehran, Iran", "lat": 35.6892, "lon": 51.3890},
    {"key": "dubai", "label": "Dubai, UAE", "lat": 25.2048, "lon": 55.2708},
    {"key": "abu dhabi", "label": "Abu Dhabi, UAE", "lat": 24.4539, "lon": 54.3773},
    {"key": "doha", "label": "Doha, Qatar", "lat": 25.2854, "lon": 51.5310},
    {"key": "riyadh", "label": "Riyadh, Saudi Arabia", "lat": 24.7136, "lon": 46.6753},
    {"key": "jerusalem", "label": "Jerusalem, Israel", "lat": 31.7683, "lon": 35.2137},
    {"key": "tel aviv", "label": "Tel Aviv, Israel", "lat": 32.0853, "lon": 34.7818},
    {"key": "haifa", "label": "Haifa, Israel", "lat": 32.7940, "lon": 34.9896},
    {"key": "gaza", "label": "Gaza", "lat": 31.5017, "lon": 34.4668},
    {"key": "rafah", "label": "Rafah, Gaza", "lat": 31.2972, "lon": 34.2436},
    {"key": "khan younis", "label": "Khan Younis, Gaza", "lat": 31.3461, "lon": 34.3039},
    {"key": "damascus", "label": "Damascus, Syria", "lat": 33.5138, "lon": 36.2765},
    {"key": "aleppo", "label": "Aleppo, Syria", "lat": 36.2021, "lon": 37.1343},
    {"key": "beirut", "label": "Beirut, Lebanon", "lat": 33.8938, "lon": 35.5018},
    {"key": "baghdad", "label": "Baghdad, Iraq", "lat": 33.3152, "lon": 44.3661},
    {"key": "ankara", "label": "Ankara, Turkey", "lat": 39.9334, "lon": 32.8597},
    {"key": "istanbul", "label": "Istanbul, Turkey", "lat": 41.0082, "lon": 28.9784},
    {"key": "cairo", "label": "Cairo, Egypt", "lat": 30.0444, "lon": 31.2357},
    {"key": "london", "label": "London, UK", "lat": 51.5074, "lon": -0.1278},
    {"key": "manchester", "label": "Manchester, UK", "lat": 53.4808, "lon": -2.2426},
    {"key": "paris", "label": "Paris, France", "lat": 48.8566, "lon": 2.3522},
    {"key": "berlin", "label": "Berlin, Germany", "lat": 52.5200, "lon": 13.4050},
    {"key": "munich", "label": "Munich, Germany", "lat": 48.1351, "lon": 11.5820},
    {"key": "rome", "label": "Rome, Italy", "lat": 41.9028, "lon": 12.4964},
    {"key": "madrid", "label": "Madrid, Spain", "lat": 40.4168, "lon": -3.7038},
    {"key": "amsterdam", "label": "Amsterdam, Netherlands", "lat": 52.3676, "lon": 4.9041},
    {"key": "brussels", "label": "Brussels, Belgium", "lat": 50.8503, "lon": 4.3517},
    {"key": "warsaw", "label": "Warsaw, Poland", "lat": 52.2297, "lon": 21.0122},
    {"key": "athens", "label": "Athens, Greece", "lat": 37.9838, "lon": 23.7275},
    {"key": "stockholm", "label": "Stockholm, Sweden", "lat": 59.3293, "lon": 18.0686},
    {"key": "kyiv", "label": "Kyiv, Ukraine", "lat": 50.4501, "lon": 30.5234},
    {"key": "kiev", "label": "Kyiv, Ukraine", "lat": 50.4501, "lon": 30.5234},
    {"key": "kharkiv", "label": "Kharkiv, Ukraine", "lat": 49.9935, "lon": 36.2304},
    {"key": "dnipro", "label": "Dnipro, Ukraine", "lat": 48.4647, "lon": 35.0462},
    {"key": "lviv", "label": "Lviv, Ukraine", "lat": 49.8397, "lon": 24.0297},
    {"key": "sumy", "label": "Sumy, Ukraine", "lat": 50.9077, "lon": 34.7981},
    {"key": "chernihiv", "label": "Chernihiv, Ukraine", "lat": 51.4982, "lon": 31.2893},
    {"key": "zaporizhzhia", "label": "Zaporizhzhia, Ukraine", "lat": 47.8388, "lon": 35.1396},
    {"key": "kherson", "label": "Kherson, Ukraine", "lat": 46.6354, "lon": 32.6169},
    {"key": "mykolaiv", "label": "Mykolaiv, Ukraine", "lat": 46.9750, "lon": 31.9946},
    {"key": "odesa", "label": "Odesa, Ukraine", "lat": 46.4825, "lon": 30.7233},
    {"key": "odessa", "label": "Odesa, Ukraine", "lat": 46.4825, "lon": 30.7233},
    {"key": "donetsk", "label": "Donetsk, Ukraine", "lat": 48.0159, "lon": 37.8029},
    {"key": "mariupol", "label": "Mariupol, Ukraine", "lat": 47.0971, "lon": 37.5434},
    {"key": "moscow", "label": "Moscow, Russia", "lat": 55.7558, "lon": 37.6173},
    {"key": "saint petersburg", "label": "Saint Petersburg, Russia", "lat": 59.9311, "lon": 30.3609},
    {"key": "st petersburg", "label": "Saint Petersburg, Russia", "lat": 59.9311, "lon": 30.3609},
    {"key": "beijing", "label": "Beijing, China", "lat": 39.9042, "lon": 116.4074},
    {"key": "shanghai", "label": "Shanghai, China", "lat": 31.2304, "lon": 121.4737},
    {"key": "hong kong", "label": "Hong Kong", "lat": 22.3193, "lon": 114.1694},
    {"key": "taipei", "label": "Taipei, Taiwan", "lat": 25.0330, "lon": 121.5654},
    {"key": "tokyo", "label": "Tokyo, Japan", "lat": 35.6762, "lon": 139.6503},
    {"key": "seoul", "label": "Seoul, South Korea", "lat": 37.5665, "lon": 126.9780},
    {"key": "new delhi", "label": "New Delhi, India", "lat": 28.6139, "lon": 77.2090},
    {"key": "delhi", "label": "New Delhi, India", "lat": 28.6139, "lon": 77.2090},
    {"key": "singapore", "label": "Singapore", "lat": 1.3521, "lon": 103.8198},
    {"key": "washington", "label": "Washington, DC, USA", "lat": 38.9072, "lon": -77.0369},
    {"key": "washington dc", "label": "Washington, DC, USA", "lat": 38.9072, "lon": -77.0369},
    {"key": "new york", "label": "New York, USA", "lat": 40.7128, "lon": -74.0060},
    {"key": "los angeles", "label": "Los Angeles, USA", "lat": 34.0522, "lon": -118.2437},
    {"key": "san francisco", "label": "San Francisco, USA", "lat": 37.7749, "lon": -122.4194},
    {"key": "chicago", "label": "Chicago, USA", "lat": 41.8781, "lon": -87.6298},
    {"key": "miami", "label": "Miami, USA", "lat": 25.7617, "lon": -80.1918},
    {"key": "atlanta", "label": "Atlanta, USA", "lat": 33.7490, "lon": -84.3880},
    {"key": "boston", "label": "Boston, USA", "lat": 42.3601, "lon": -71.0589},
    {"key": "philadelphia", "label": "Philadelphia, USA", "lat": 39.9526, "lon": -75.1652},
    {"key": "dallas", "label": "Dallas, USA", "lat": 32.7767, "lon": -96.7970},
    {"key": "houston", "label": "Houston, USA", "lat": 29.7604, "lon": -95.3698},
    {"key": "austin", "label": "Austin, USA", "lat": 30.2672, "lon": -97.7431},
    {"key": "seattle", "label": "Seattle, USA", "lat": 47.6062, "lon": -122.3321},
    {"key": "toronto", "label": "Toronto, Canada", "lat": 43.6532, "lon": -79.3832},
    {"key": "ottawa", "label": "Ottawa, Canada", "lat": 45.4215, "lon": -75.6972},
    {"key": "vancouver", "label": "Vancouver, Canada", "lat": 49.2827, "lon": -123.1207},
    {"key": "montreal", "label": "Montreal, Canada", "lat": 45.5017, "lon": -73.5673},
    {"key": "mexico city", "label": "Mexico City, Mexico", "lat": 19.4326, "lon": -99.1332},
    {"key": "brasilia", "label": "Brasília, Brazil", "lat": -15.7939, "lon": -47.8828},
    {"key": "sao paulo", "label": "São Paulo, Brazil", "lat": -23.5558, "lon": -46.6396},
    {"key": "rio de janeiro", "label": "Rio de Janeiro, Brazil", "lat": -22.9068, "lon": -43.1729},
    {"key": "buenos aires", "label": "Buenos Aires, Argentina", "lat": -34.6037, "lon": -58.3816},
    {"key": "sydney", "label": "Sydney, Australia", "lat": -33.8688, "lon": 151.2093},
    {"key": "melbourne", "label": "Melbourne, Australia", "lat": -37.8136, "lon": 144.9631},
]

_COUNTRY_FALLBACKS: dict[str, dict[str, Any]] = {
    "us": {"label": "Washington, DC, USA", "lat": 38.9072, "lon": -77.0369},
    "usa": {"label": "Washington, DC, USA", "lat": 38.9072, "lon": -77.0369},
    "united states": {"label": "Washington, DC, USA", "lat": 38.9072, "lon": -77.0369},
    "uk": {"label": "London, UK", "lat": 51.5074, "lon": -0.1278},
    "united kingdom": {"label": "London, UK", "lat": 51.5074, "lon": -0.1278},
    "germany": {"label": "Berlin, Germany", "lat": 52.5200, "lon": 13.4050},
    "france": {"label": "Paris, France", "lat": 48.8566, "lon": 2.3522},
    "ukraine": {"label": "Kyiv, Ukraine", "lat": 50.4501, "lon": 30.5234},
    "russia": {"label": "Moscow, Russia", "lat": 55.7558, "lon": 37.6173},
    "china": {"label": "Beijing, China", "lat": 39.9042, "lon": 116.4074},
    "japan": {"label": "Tokyo, Japan", "lat": 35.6762, "lon": 139.6503},
    "israel": {"label": "Jerusalem, Israel", "lat": 31.7683, "lon": 35.2137},
    "iran": {"label": "Tehran, Iran", "lat": 35.6892, "lon": 51.3890},
    "uae": {"label": "Dubai, UAE", "lat": 25.2048, "lon": 55.2708},
    "united arab emirates": {"label": "Dubai, UAE", "lat": 25.2048, "lon": 55.2708},
    "india": {"label": "New Delhi, India", "lat": 28.6139, "lon": 77.2090},
    "canada": {"label": "Ottawa, Canada", "lat": 45.4215, "lon": -75.6972},
    "australia": {"label": "Canberra, Australia", "lat": -35.2809, "lon": 149.1300},
}

_MAP_ALIAS_TO_KEY: dict[str, str] = {
    "u.s.": "united states",
    "u.s": "united states",
    "us": "united states",
    "u.k.": "united kingdom",
    "uk": "united kingdom",
    "washington, dc": "washington dc",
    "washington d.c.": "washington dc",
    "washington d.c": "washington dc",
    "dc": "washington dc",
    "nyc": "new york",
    "la": "los angeles",
    "st. petersburg": "st petersburg",
    "sao paolo": "sao paulo",
}

_MAP_PLACE_BY_KEY: dict[str, dict[str, Any]] = {entry["key"]: entry for entry in _MAP_PLACE_INDEX}
for alias, target in _MAP_ALIAS_TO_KEY.items():
    if target in _MAP_PLACE_BY_KEY:
        _MAP_PLACE_BY_KEY[alias] = _MAP_PLACE_BY_KEY[target]

_MAP_KEYS_SORTED = sorted(_MAP_PLACE_BY_KEY.keys(), key=len, reverse=True)
_MAP_GEO_CACHE: dict[str, dict[str, Any]] = {}

_EVENT_LOCATION_STOPWORDS = {
    "trump", "biden", "zelenskyy", "zelenskiy", "putin", "maga", "tucker", "carlson",
    "republican", "democrat", "kennedy", "bessette", "tv", "series", "marketwatch",
    "france24", "bloomberg", "cnn", "bbc", "nyt", "ukraine", "russia", "iran", "israel",
    "u.s", "u.s.", "us", "usa", "u.k", "u.k.", "uk", "eu", "un", "u.n.",
    "nationwide", "statewide", "global", "world", "international",
}
_EVENT_KEYWORDS = (
    "attack", "attacks", "attacked", "strike", "strikes", "struck", "drone", "missile", "shelling",
    "bombing", "bombed", "killed", "kills", "killing", "dead", "dies", "died", "injured", "injures",
    "explosion", "blast", "earthquake", "quake", "flood", "flooding", "wildfire", "fire", "crash",
    "shooting", "protest", "protests", "alert", "evacuation", "raid", "raids", "offensive", "battle",
    "war", "hit", "hits", "celebrate", "celebration", "demonstrators", "demonstration"
)
_LOCATION_PREPOSITIONS = ("in", "near", "outside", "around", "across", "at", "inside", "from", "off")
_COUNTRY_ONLY_KEYS = set(_COUNTRY_FALLBACKS.keys())


def _normalize_location_text(text: str) -> str:
    s = (text or "").lower()
    s = s.replace("’", "'").replace("‘", "'").replace("`", "'")
    s = re.sub(r"[^a-z0-9\s,.'-]+", " ", s)
    s = s.replace("d.c.", "dc").replace("d.c", "dc")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _display_location_text(text: str) -> str:
    s = str(text or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s.strip(" ,.;:-")


def _looks_like_location_candidate(raw: str) -> bool:
    disp = _display_location_text(raw)
    if not disp or len(disp) < 3 or len(disp) > 64:
        return False
    norm = _normalize_location_text(disp)
    if not norm or norm in _EVENT_LOCATION_STOPWORDS or norm in _COUNTRY_ONLY_KEYS:
        return False
    words = [w for w in re.split(r"[-\s]+", disp) if w]
    if not words or len(words) > 5:
        return False
    banned = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"}
    if any(w.lower() in banned for w in words):
        return False
    capitals = sum(1 for w in words if w[:1].isupper() or w[:1].isdigit())
    return capitals >= max(1, len(words) - 1)


def _event_pattern_location_candidates(text: str) -> list[str]:
    raw = str(text or "")
    if not raw:
        return []
    keyword_re = r"(?:" + "|".join(re.escape(x) for x in _EVENT_KEYWORDS) + r")"
    prep_re = r"(?:" + "|".join(re.escape(x) for x in _LOCATION_PREPOSITIONS) + r")"
    patterns = [
        rf"{keyword_re}[^.\n,:;]{{0,120}}?\b{prep_re}\s+([A-Z][A-Za-z'’.-]*(?:[ -][A-Z][A-Za-z'’.-]*){{0,3}})",
        rf"\b([A-Z][A-Za-z'’.-]*(?:[ -][A-Z][A-Za-z'’.-]*){{0,3}})\b[^.\n,:;]{{0,40}}?(?:was|were|is|are)?\s*(?:hit|hits|struck|attacked|bombed|shelled|flooded|evacuated)\b",
        rf"\b([A-Z][A-Za-z'’.-]*(?:[ -][A-Z][A-Za-z'’.-]*){{0,3}}),\s*([A-Z][A-Za-z'’.-]*(?:[ -][A-Z][A-Za-z'’.-]*){{0,3}})",
    ]
    out: list[str] = []
    for pat in patterns:
        for m in re.finditer(pat, raw):
            for grp in [g for g in m.groups() if g][:2]:
                cand = _display_location_text(grp)
                if _looks_like_location_candidate(cand):
                    out.append(cand)
    dedup: list[str] = []
    seen: set[str] = set()
    for cand in out:
        norm = _normalize_location_text(cand)
        if norm and norm not in seen:
            seen.add(norm)
            dedup.append(cand)
    return dedup


def _cluster_location_parts(c: dict[str, Any], sources: list[dict[str, Any]]) -> dict[str, str]:
    summary_chunks = [c.get("summary_text") or "", c.get("country") or "", c.get("topic") or ""]
    try:
        sj = _safe_json_load(c.get("summary_json")) or {}
        summary_chunks.append(sj.get("brief") or "")
        for arr_key in ("key_facts", "uncertainties"):
            arr = sj.get(arr_key)
            if isinstance(arr, list):
                summary_chunks.extend(str(x) for x in arr[:6])
    except Exception:
        pass
    source_title_chunks: list[str] = []
    source_name_chunks: list[str] = []
    source_desc_chunks: list[str] = []
    for s in sources[:10]:
        source_title_chunks.append(s.get("title") or "")
        source_name_chunks.append(s.get("source_name") or "")
        source_desc_chunks.append(s.get("description") or "")
    return {
        "title": c.get("title") or "",
        "summary": " ".join(x for x in summary_chunks if x),
        "source_titles": " ".join(x for x in source_title_chunks if x),
        "source_descriptions": " ".join(x for x in source_desc_chunks if x),
        "source_names": " ".join(x for x in source_name_chunks if x),
    }


def _iter_location_matches(text: str) -> list[tuple[str, dict[str, Any]]]:
    norm = _normalize_location_text(text)
    if not norm:
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for key in _MAP_KEYS_SORTED:
        entry = _MAP_PLACE_BY_KEY.get(key)
        if not entry:
            continue
        if re.search(rf"(?<![a-z]){re.escape(key)}(?![a-z])", norm):
            out.append((key, entry))
    return out


def _extract_cluster_map_location(c: dict[str, Any], sources: Optional[list[dict[str, Any]]] = None) -> Optional[dict[str, Any]]:
    srcs = list(sources or [])
    cid = str(c.get("id") or "")
    cache_key = hashlib.sha1((cid + "|" + str(c.get("updated_at") or "") + "|" + str(c.get("title") or "")).encode("utf-8", errors="ignore")).hexdigest()
    hit = _MAP_GEO_CACHE.get(cache_key)
    if hit:
        return dict(hit)

    parts = _cluster_location_parts(c, srcs)
    weighted_sections = [
        ("title", 120, 0.98),
        ("summary", 70, 0.90),
        ("source_titles", 48, 0.82),
        ("source_descriptions", 20, 0.72),
        ("source_names", 8, 0.58),
    ]

    scores: dict[str, dict[str, Any]] = {}
    section_keys: dict[str, set[str]] = {}

    def add_score(entry: dict[str, Any], matched_key: str, amount: int, confidence: float) -> None:
        canonical_key = str(entry.get("key") or matched_key)
        bucket = scores.setdefault(canonical_key, {"score": 0, "entry": entry, "match": matched_key, "confidence": confidence, "sections": set()})
        bucket["score"] += int(amount)
        bucket["sections"].add(matched_key)
        if confidence > bucket["confidence"]:
            bucket["confidence"] = confidence
            bucket["match"] = matched_key

    for section_name, base_score, confidence in weighted_sections:
        matches = _iter_location_matches(parts.get(section_name, ""))
        matched_keys_in_section: set[str] = set()
        for idx, (matched_key, entry) in enumerate(matches):
            matched_keys_in_section.add(str(entry.get("key") or matched_key))
            bonus = max(0, 14 - min(idx, 12))
            add_score(entry, matched_key, base_score + bonus, confidence)
        section_keys[section_name] = matched_keys_in_section

    # Strong title event patterns beat generic country mentions.
    for idx, cand in enumerate(_event_pattern_location_candidates(parts.get("title", ""))):
        norm = _normalize_location_text(cand)
        entry = _MAP_PLACE_BY_KEY.get(norm)
        if entry:
            add_score(entry, norm, 180 - min(idx * 12, 36), 0.99)

    # Summary/source titles can reinforce a city already hinted by the title.
    for section_name, base_score, confidence in (("summary", 42, 0.90), ("source_titles", 34, 0.84), ("source_descriptions", 18, 0.74)):
        for idx, cand in enumerate(_event_pattern_location_candidates(parts.get(section_name, ""))[:4]):
            norm = _normalize_location_text(cand)
            entry = _MAP_PLACE_BY_KEY.get(norm)
            if entry:
                add_score(entry, norm, base_score - min(idx * 4, 12), confidence)

    # Penalize broad country fallback keys when a more specific city is present anywhere.
    specific_city_keys = {k for k in scores if k not in _COUNTRY_ONLY_KEYS}
    if specific_city_keys:
        for key, bucket in list(scores.items()):
            if key in _COUNTRY_ONLY_KEYS:
                bucket["score"] -= 90
                bucket["confidence"] = min(float(bucket["confidence"]), 0.50)

    # Prefer candidates confirmed by multiple sections.
    for bucket in scores.values():
        section_count = len(bucket.get("sections") or ())
        if section_count >= 2:
            bucket["score"] += 16 * min(section_count, 3)

    best: Optional[dict[str, Any]] = None
    if scores:
        best = max(scores.values(), key=lambda x: (int(x["score"]), float(x["confidence"]), len(str(x["entry"].get("key") or ""))))

    if best and int(best["score"]) >= 56:
        entry = best["entry"]
        result = {
            "label": entry["label"],
            "lat": entry["lat"],
            "lon": entry["lon"],
            "confidence": round(float(best["confidence"]), 2),
            "match": best["match"],
            "kind": "city",
        }
        _MAP_GEO_CACHE[cache_key] = dict(result)
        return result

    ctry = _normalize_location_text(str(c.get("country") or ""))
    if ctry and ctry not in {"world", "global", "international", "general"} and ctry in _COUNTRY_FALLBACKS:
        fb = _COUNTRY_FALLBACKS[ctry]
        result = {
            "label": fb["label"],
            "lat": fb["lat"],
            "lon": fb["lon"],
            "confidence": 0.45,
            "match": ctry,
            "kind": "country",
        }
        _MAP_GEO_CACHE[cache_key] = dict(result)
        return result

    return None


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
    keep_days: int,
) -> str:
    qn = (q or "").strip().lower()
    sn = (since or "").strip()
    inorm = (interests or "general").strip().lower()
    v = (variant or "guest").strip().lower()
    return f"v5|{bucket}|v={v}|i={inorm}|c={country}|l={language}|ui={ui_lang}|since={sn}|q={qn}|limit={limit}|days={int(keep_days)}"

_REFRESH_STATE: dict[str, Any] = {"last_ts_by_ip": {}}
REFRESH_COOLDOWN_SECONDS = 180
FEED_KEEP_DAYS = 30
FEED_KEEP_DAYS_PRO = 60
FEED_KEEP_DAYS_ANALYST = 90
FEED_MAX_ITEMS_FREE = 120
FEED_MAX_ITEMS_PRO = 300
FEED_MAX_ITEMS_ANALYST = 500


def _feed_limits_for_plan(plan: str | None) -> tuple[int, int]:
    p = str(plan or "free").strip().lower()
    if p == "analyst":
        return FEED_MAX_ITEMS_ANALYST, FEED_KEEP_DAYS_ANALYST
    if p == "pro":
        return FEED_MAX_ITEMS_PRO, FEED_KEEP_DAYS_PRO
    return FEED_MAX_ITEMS_FREE, FEED_KEEP_DAYS


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


def _source_sort_key(s: dict[str, Any]) -> tuple[datetime, int, str]:
    dt = _parse_dt(s.get("published_at")) or _parse_dt(s.get("inserted_at")) or datetime.max
    try:
        sid = int(s.get("id") or 0)
    except Exception:
        sid = 0
    name = str(s.get("source_name") or "").strip().lower()
    return (dt, sid, name)


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

        # "First source" means the earliest article in the cluster, not the newest.
        earliest_sources = sorted(sources, key=_source_sort_key)
        primary_source = (earliest_sources[0].get("source_name") if earliest_sources else None)

        # choose event image: first non-empty article image_url from the freshest rows
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
        summary_brief = _extract_brief_from_text(c.get("summary_text") or "")

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
        "map_location": _extract_cluster_map_location(c, sources),
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
                "inserted_at": s.get("inserted_at"),
            }
            for s in sources
        ]

    return payload


def _redact_item_for_guest(it: dict[str, Any]) -> dict[str, Any]:
    """Guest responses should remain fully readable.

    Keep the helper name for compatibility with existing call sites, but do
    not strip summary, sources, or credibility details anymore.
    """
    it = dict(it)
    it["guest_locked"] = False
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
    interests = _normalize_interest_selection(interests)

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
    interests = _normalize_interest_selection(p.interests or [])

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
    background_tasks: BackgroundTasks,
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

        plan = "free"
        if user is not None:
            try:
                sub = db.get_user_subscription(int(user["id"]))
                if sub and sub.get("plan"):
                    plan = str(sub.get("plan") or "free").strip().lower()
            except Exception:
                plan = "free"

        max_limit_for_plan, keep_days_for_plan = _feed_limits_for_plan(plan)
        limit_n = max(1, min(max_limit_for_plan, int(limit or max_limit_for_plan)))

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
            variant=(f"auth:{plan}" if user else "guest"),
            keep_days=keep_days_for_plan,
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

        # Build the final visible feed first, then apply guest redaction.
        # Otherwise a guest may see a card in the top 3, but opening that same
        # card via /api/news/by_ids can still be treated as locked because the
        # server compared against a different pre-filter/pre-sort list.
        items: list[dict[str, Any]] = [
            _decorate_cluster_row(c, include_sources=True) for c in clusters
        ]

        cutoff = _days_ago_iso(keep_days_for_plan)
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

        # Guests now receive the same fully readable feed payload as signed-in users.
        if user is None:
            for it in items:
                it["guest_locked"] = False

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
            "plan": plan,
            "max_limit": max_limit_for_plan,
            "keep_days": keep_days_for_plan,
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
        it = _decorate_cluster_row(c, include_sources=True)
        it["guest_locked"] = False
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



def _normalize_visual_text(s: str) -> str:
    s = html.unescape(str(s or "").lower())
    s = re.sub(r"https?://\S+", " ", s)
    s = re.sub(r"[^\w\s-]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _visual_tokens(s: str) -> list[str]:
    toks = []
    for tok in re.split(r"[^\w-]+", _normalize_visual_text(s)):
        tok = tok.strip("-_")
        if len(tok) < 3:
            continue
        if tok.isdigit() and len(tok) < 4:
            continue
        toks.append(tok)
    out = []
    seen = set()
    for tok in toks:
        if tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
    return out


def _char_ngrams(s: str, n: int = 3) -> set[str]:
    t = _normalize_visual_text(s).replace(" ", "")
    if len(t) <= n:
        return {t} if t else set()
    return {t[i:i+n] for i in range(0, len(t)-n+1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter <= 0:
        return 0.0
    union = len(a | b)
    return float(inter) / float(max(1, union))


def _visual_doc_text(item: dict[str, Any]) -> str:
    parts = [
        str(item.get("title") or ""),
        str(item.get("summary") or ""),
        str(item.get("primary_source") or ""),
    ]
    for s in (item.get("sources") or []):
        parts.append(str(s.get("title") or ""))
        parts.append(str(s.get("source_name") or ""))
        parts.append(str(s.get("description") or ""))
    return " ".join(p for p in parts if p).strip()


def _clip_visual_query_text(text: str, max_words: int = 14, max_chars: int = 140) -> str:
    s = re.sub(r"\s+", " ", str(text or "").strip())
    if not s:
        return ""
    words = s.split()
    if len(words) > max_words:
        s = " ".join(words[:max_words]).strip()
    if len(s) > max_chars:
        s = s[:max_chars].rsplit(" ", 1)[0].strip() or s[:max_chars].strip()
    return s


def _visual_named_entities(text: str, max_items: int = 10) -> list[str]:
    raw = re.findall(r"\b[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,2}\b|\b[A-Z]{2,}\b", str(text or ""))
    out: list[str] = []
    seen: set[str] = set()
    stop = {"The", "This", "That", "And", "But", "For", "With", "From", "Into", "Over", "After", "Before", "Wednesday", "Tuesday", "Thursday", "Friday"}
    for item in raw:
        item = re.sub(r"\s+", " ", item).strip(" ,.;:-—–|•")
        if not item or item in stop:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= max_items:
            break
    return out


def _visual_phrase_candidates(ocr_text: str) -> list[str]:
    parts = [
        re.sub(r"\s+", " ", part).strip(" -–—|•,.;:'\"")
        for part in re.split(r"[\n\r]+|(?<=[.!?])\s+", ocr_text or "")
        if part and part.strip()
    ]
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        words = part.split()
        if len(words) < 5:
            continue
        windows: list[str] = []
        if len(words) <= 18:
            windows.append(part)
        else:
            windows.append(" ".join(words[:18]))
            mid = max(0, min(len(words) - 10, len(words) // 2 - 5))
            windows.append(" ".join(words[mid:mid + 10]))
            windows.append(" ".join(words[-12:]))
        for cand in windows:
            cand = _clip_visual_query_text(cand, max_words=18, max_chars=180)
            if not cand:
                continue
            key = cand.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(cand)
            if len(out) >= 12:
                return out
    return out


def _visual_query_candidates(query_text: str, ocr_text: str) -> list[str]:
    candidates: list[str] = []

    def add(value: str, *, max_words: int = 18, max_chars: int = 180) -> None:
        value = _clip_visual_query_text(value, max_words=max_words, max_chars=max_chars)
        if not value:
            return
        if len(_visual_tokens(value)) < 3 and len(value.split()) < 3:
            return
        if value not in candidates:
            candidates.append(value)

    add(query_text, max_words=14, max_chars=140)
    add(ocr_text, max_words=22, max_chars=220)

    lines = [
        re.sub(r"\s+", " ", line).strip(" -–—|•")
        for line in re.split(r"[\n\r]+", ocr_text or "")
        if line.strip()
    ]
    if not lines and ocr_text:
        lines = [part.strip() for part in re.split(r"(?<=[.!?])\s+", ocr_text) if part.strip()]

    headline_like: list[str] = []
    for line in lines:
        words = line.split()
        if 4 <= len(words) <= 22:
            headline_like.append(line)
        elif len(words) > 22:
            headline_like.append(" ".join(words[:22]))

    for line in headline_like[:10]:
        add(line, max_words=18, max_chars=180)
        words = line.split()
        if len(words) >= 8:
            add(" ".join(words[:12]), max_words=12, max_chars=120)

    for phrase in _visual_phrase_candidates(ocr_text)[:12]:
        add(phrase, max_words=18, max_chars=180)

    entities = _visual_named_entities(ocr_text)
    if entities:
        add(" ".join(entities[:4]), max_words=10, max_chars=120)
        add(" ".join(entities[:6]), max_words=14, max_chars=140)

    if ocr_text:
        toks = _visual_tokens(ocr_text)[:18]
        if toks:
            add(" ".join(toks[:8]), max_words=8, max_chars=100)
            add(" ".join(toks[:12]), max_words=12, max_chars=140)

    return candidates or [_clip_visual_query_text(query_text or ocr_text)]


def _choose_best_visual_query(query_text: str, ocr_text: str, docs: list[str]) -> str:
    candidates = [c for c in _visual_query_candidates(query_text, ocr_text) if c]
    if not candidates:
        return _clip_visual_query_text(query_text or ocr_text)
    if not docs:
        return candidates[0]

    try:
        vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), max_features=12000)
        X = vec.fit_transform(candidates + docs)
        cand_X = X[:len(candidates)]
        doc_X = X[len(candidates):]
        sims = cosine_similarity(cand_X, doc_X)
    except Exception:
        sims = None

    best = candidates[0]
    best_score = -1.0
    docs_joined = "\n".join(docs[:200])
    docs_norm = _normalize_visual_text(docs_joined)
    docs_tokens = set(_visual_tokens(docs_joined))

    for idx, cand in enumerate(candidates):
        cand_norm = _normalize_visual_text(cand)
        cand_tokens = set(_visual_tokens(cand))
        token_overlap = (len(cand_tokens & docs_tokens) / max(1, len(cand_tokens))) if cand_tokens else 0.0
        substring_bonus = 0.25 if cand_norm and cand_norm in docs_norm else 0.0
        char_bonus = _jaccard(_char_ngrams(cand, 3), _char_ngrams(docs_joined, 3)) * 0.25
        tfidf_bonus = float(sims[idx].max()) if sims is not None and len(docs) else 0.0
        short_bonus = max(0.0, 0.08 - max(0, len(cand.split()) - 10) * 0.01)
        score = tfidf_bonus + token_overlap * 0.45 + substring_bonus + char_bonus + short_bonus
        if score > best_score:
            best_score = score
            best = cand

    return _clip_visual_query_text(best)


def _score_visual_match(query_text: str, ocr_text: str, item: dict[str, Any], tfidf_sim: float) -> float:
    doc = _visual_doc_text(item)
    q_norm = _normalize_visual_text(query_text)
    ocr_norm = _normalize_visual_text(ocr_text)
    doc_norm = _normalize_visual_text(doc)

    q_tokens = set(_visual_tokens(query_text))
    ocr_tokens = set(_visual_tokens(ocr_text))
    source_title_tokens = set()
    source_desc_tokens = set()
    for s in (item.get("sources") or []):
        source_title_tokens.update(_visual_tokens(str(s.get("title") or "")))
        source_desc_tokens.update(_visual_tokens(str(s.get("description") or "")))

    all_tokens: list[str] = []
    seen = set()
    for tok in list(q_tokens) + list(ocr_tokens):
        if tok in seen:
            continue
        seen.add(tok)
        all_tokens.append(tok)

    title_l = _normalize_visual_text(str(item.get("title") or ""))
    summary_l = _normalize_visual_text(str(item.get("summary") or ""))
    source_titles = [_normalize_visual_text(str(s.get("title") or "")) for s in (item.get("sources") or [])]
    source_descs = [_normalize_visual_text(str(s.get("description") or "")) for s in (item.get("sources") or [])]
    source_names = [_normalize_visual_text(str(s.get("source_name") or "")) for s in (item.get("sources") or [])]

    score = float(tfidf_sim or 0.0) * 0.65

    if q_norm and q_norm in doc_norm:
        score += 0.45
    if ocr_norm and ocr_norm in doc_norm:
        score += 0.38

    query_parts = [p for p in q_norm.split() if len(p) >= 4]
    if len(query_parts) >= 2:
        hit_ratio = sum(1 for p in query_parts if p in doc_norm) / max(1, len(query_parts))
        score += min(0.22, hit_ratio * 0.28)

    strong_hits = 0
    medium_hits = 0
    weak_hits = 0
    for tok in all_tokens:
        if tok in title_l or any(tok in st for st in source_titles):
            strong_hits += 1
            continue
        if tok in summary_l or tok in source_title_tokens or any(tok in sd for sd in source_descs):
            medium_hits += 1
            continue
        if tok in source_desc_tokens or any(tok in sn for sn in source_names):
            weak_hits += 1

    if all_tokens:
        token_coverage = (strong_hits + medium_hits * 0.8 + weak_hits * 0.35) / max(1.0, len(all_tokens))
        score += min(0.28, token_coverage * 0.34)

    entity_hits = 0
    entities = _visual_named_entities(ocr_text, max_items=12)
    for ent in entities:
        ent_n = _normalize_visual_text(ent)
        if ent_n and ent_n in doc_norm:
            entity_hits += 1
    if entities:
        score += min(0.18, (entity_hits / max(1, len(entities))) * 0.24)

    q_char = _char_ngrams(query_text, 3)
    doc_char = _char_ngrams(doc, 3)
    score += min(0.14, _jaccard(q_char, doc_char) * 0.38)

    ocr_char = _char_ngrams(ocr_text, 3)
    if ocr_char:
        score += min(0.20, _jaccard(ocr_char, doc_char) * 0.50)

    long_phrase_hits = 0.0
    for phrase in _visual_phrase_candidates(ocr_text)[:8]:
        phrase_n = _normalize_visual_text(phrase)
        phrase_tokens = _visual_tokens(phrase)
        if not phrase_n or not phrase_tokens:
            continue
        if phrase_n in doc_norm:
            long_phrase_hits += 1.0
        elif sum(1 for tok in phrase_tokens if tok in doc_norm) >= max(3, int(len(phrase_tokens) * 0.6)):
            long_phrase_hits += 0.5
    score += min(0.18, long_phrase_hits * 0.05)

    try:
        sources_count = int(item.get("sources_count") or 0)
    except Exception:
        sources_count = 0
    if strong_hits >= 2:
        score += 0.05
    if medium_hits >= 3:
        score += 0.04
    if sources_count >= 3:
        score += 0.015

    latest = str(item.get("latest_published_at") or "")
    try:
        dt = datetime.fromisoformat(latest.replace("Z", "+00:00")) if latest else None
    except Exception:
        dt = None
    if dt is not None:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age_hours = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
        if age_hours <= 48:
            score += 0.03
        elif age_hours <= 168:
            score += 0.015

    return round(score, 6)


@router.post("/api/news/visual-search")
async def news_visual_search(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    user=Depends(get_current_user_optional),
    ui_lang: str = "en",
    interests: str = "",
    country: str = "world",
    language: str = "all",
    limit: int = 60,
) -> dict[str, Any]:
    """Find relevant feed items from an uploaded screenshot/news image."""
    db.ensure_schema()

    if image is None:
        raise HTTPException(status_code=400, detail="Image file is required")

    filename = (image.filename or "image").strip()
    content_type = (image.content_type or "application/octet-stream").strip().lower()

    allowed_types = {
        "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif"
    }
    if content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported image format")

    try:
        raw = await image.read()
    except Exception:
        raw = b""

    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded image is empty")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image is too large (max 12 MB)")

    try:
        signal = extract_visual_search_signal(
            image_bytes=raw,
            mime_type=content_type,
            ui_lang=ui_lang,
            model=(os.getenv("OPENAI_VISUAL_SEARCH_MODEL", "").strip() or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")),
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not analyze image: {e}")

    query_text = str(signal.get("query") or "").strip()
    ocr_text = str(signal.get("text") or "").strip()

    interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
    country = (country or "world").strip().lower()
    language = (language or "all").strip().lower()
    limit_n = max(1, min(200, int(limit or 60)))
    ui_lang = (ui_lang or "en").strip().lower()

    # Start with the user's current feed scope, then widen if needed.
    candidate_sets: list[list[dict[str, Any]]] = []
    try:
        candidate_sets.append(db.query_clusters(
            interests=interests_list,
            country=country,
            language=language,
            since_iso=(datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
            limit=500,
        ))
    except Exception:
        candidate_sets.append([])

    try:
        candidate_sets.append(db.query_clusters(
            interests=[],
            country=country if country != "world" else "",
            language="all",
            since_iso=(datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
            limit=500,
        ))
    except Exception:
        candidate_sets.append([])

    try:
        candidate_sets.append(db.query_clusters(
            interests=[],
            country="",
            language="all",
            since_iso=(datetime.now(timezone.utc) - timedelta(days=45)).isoformat(),
            limit=650,
        ))
    except Exception:
        candidate_sets.append([])

    dedup_rows: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for group in candidate_sets:
        for row in (group or []):
            try:
                cid = int(row.get("id") or 0)
            except Exception:
                cid = 0
            if cid <= 0 or cid in seen_ids:
                continue
            seen_ids.add(cid)
            dedup_rows.append(row)
            if len(dedup_rows) >= 700:
                break
        if len(dedup_rows) >= 700:
            break


    is_guest = user is None
    decorated: list[dict[str, Any]] = []
    for idx, c in enumerate(dedup_rows):
        it = _decorate_cluster_row(c, include_sources=True)
        it["guest_locked"] = False
        decorated.append(it)

    def _doc_text(it: dict[str, Any]) -> str:
        return _visual_doc_text(it)

    docs = [_doc_text(it) for it in decorated]
    best_query_text = _choose_best_visual_query(query_text=query_text, ocr_text=ocr_text, docs=docs)
    combined_query = " | ".join(x for x in [best_query_text, ocr_text] if x).strip()

    try:
        vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), max_features=12000)
        X = vec.fit_transform([combined_query] + docs)
        sims = cosine_similarity(X[0:1], X[1:]).ravel()
    except Exception:
        sims = [0.0 for _ in docs]

    scored: list[tuple[float, dict[str, Any]]] = []
    for it, sim in zip(decorated, sims):
        score = _score_visual_match(query_text=best_query_text or query_text, ocr_text=ocr_text, item=it, tfidf_sim=float(sim or 0.0))
        if country and country != "world" and str(it.get("country") or "").strip().lower() == country:
            score += 0.015
        it["similarity"] = round(score, 4)
        scored.append((score, it))

    scored.sort(
        key=lambda x: (
            x[0],
            int((x[1].get("credibility_score") or 0)),
            int((x[1].get("sources_count") or 0)),
            str(x[1].get("latest_published_at") or ""),
        ),
        reverse=True,
    )

    filtered = [it for score, it in scored if score >= 0.09]
    if len(filtered) < 8:
        filtered = [it for _, it in scored[: min(24, len(scored))]]

    filtered = filtered[:limit_n]

    if ui_lang:
        try:
            filtered = await translate_feed_items(filtered, ui_lang=ui_lang)
        except Exception:
            pass

    return {
        "status": "ok",
        "count": len(filtered),
        "items": filtered,
        "query": best_query_text or query_text,
        "search_text": combined_query,
        "ocr_text": ocr_text,
        "ocr_language": signal.get("language") or "unknown",
        "ocr_confidence": signal.get("confidence") or 0.0,
        "filename": filename,
    }

@router.get("/api/news/by_ids")
async def news_by_ids(
    ids: str,
    background_tasks: BackgroundTasks,
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
    _queue_missing_summaries(rows, background_tasks, max_jobs=6)
    items = [_decorate_cluster_row(r, include_sources=True) for r in rows]

    # Guests now receive the same fully readable detail payload as signed-in users.
    if user is None:
        for it in items:
            it["guest_locked"] = False

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
        r = requests.get(url, params=params, timeout=(2.5, 4.5))
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
        r = requests.get(url, params=params, timeout=(2.5, 4.5))
        if not r.ok:
            raise RuntimeError(f"crypto_http_{r.status_code}")
        j = r.json() or {}
        out = {"vs": vs_u, "prices": j}
        _market_set_cached(cache_key, out)
        return out
    except Exception as e:
        log_market.warning("crypto proxy failed: %s", e)
        stale = _market_get_stale(cache_key, max_age=15 * 60)
        if stale is not None:
            out = dict(stale)
            out["stale"] = True
            out["detail"] = "crypto_stale"
            return out
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

def _source_allowed_url(raw_url: str) -> str:
    url = str(raw_url or '').strip()
    if not url:
        raise HTTPException(status_code=400, detail='Missing url')
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise HTTPException(status_code=400, detail='Invalid url')
    return url


def _source_browser_headers(url: str) -> dict[str, str]:
    parsed = urllib.parse.urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'Referer': origin + '/',
    }


def _clean_source_text(value: str) -> str:
    return ' '.join(str(value or '').replace(' ', ' ').split()).strip()


def _extract_ld_json_article_data(soup: BeautifulSoup, final_url: str) -> dict[str, Any]:
    best: dict[str, Any] = {}
    scripts = soup.find_all('script', attrs={'type': 'application/ld+json'})
    for script in scripts:
        raw = script.string or script.get_text(' ', strip=True) or ''
        raw = raw.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        queue = payload if isinstance(payload, list) else [payload]
        while queue:
            item = queue.pop(0)
            if isinstance(item, list):
                queue.extend(item)
                continue
            if not isinstance(item, dict):
                continue
            if '@graph' in item and isinstance(item.get('@graph'), list):
                queue.extend(item.get('@graph') or [])
            raw_type = item.get('@type')
            types = raw_type if isinstance(raw_type, list) else [raw_type]
            norm_types = {str(t).lower() for t in types if t}
            if not norm_types.intersection({'newsarticle', 'article', 'reportage', 'analysisnewsarticle'}):
                continue
            article_body = _clean_source_text(item.get('articleBody') or '')
            title = _clean_source_text(item.get('headline') or item.get('name') or '')
            desc = _clean_source_text(item.get('description') or '')
            image = ''
            image_val = item.get('image')
            if isinstance(image_val, str):
                image = image_val.strip()
            elif isinstance(image_val, list) and image_val:
                image = str(image_val[0] or '').strip()
            elif isinstance(image_val, dict):
                image = str(image_val.get('url') or image_val.get('@id') or '').strip()
            if image:
                image = urllib.parse.urljoin(final_url, image)
            if len(article_body) > len(best.get('articleBody') or ''):
                best = {
                    'title': title,
                    'description': desc,
                    'image': image,
                    'articleBody': article_body,
                }
    return best


def _extract_readable_article(html_text: str, final_url: str) -> dict[str, Any]:
    soup = BeautifulSoup(html_text or '', 'html.parser')

    title = ''
    if soup.title and soup.title.text:
        title = _clean_source_text(soup.title.text)
    og_title = soup.find('meta', attrs={'property': 'og:title'})
    if og_title and og_title.get('content'):
        title = _clean_source_text(og_title.get('content')) or title

    desc = ''
    for attrs in ({'name': 'description'}, {'property': 'og:description'}):
        tag = soup.find('meta', attrs=attrs)
        if tag and tag.get('content'):
            desc = _clean_source_text(tag.get('content'))
            if desc:
                break

    image = ''
    og_img = soup.find('meta', attrs={'property': 'og:image'})
    if og_img and og_img.get('content'):
        image = urllib.parse.urljoin(final_url, _clean_source_text(og_img.get('content')))

    ld_article = _extract_ld_json_article_data(soup, final_url)
    if ld_article.get('title') and not title:
        title = ld_article.get('title') or title
    if ld_article.get('description') and not desc:
        desc = ld_article.get('description') or desc
    if ld_article.get('image') and not image:
        image = ld_article.get('image') or image

    containers = []
    for selector in [
        'article', 'main', '[role="main"]',
        '[itemprop="articleBody"]', '[data-testid="article-body"]',
        '.article-content', '.entry-content', '.post-content', '.story-body',
        '.article__content', '.article-content__content-group', '.article-body',
        '.article-body__content', '.story-content', '.content__article-body',
        '.a-content', '.c-entry-content', '.node__content', '.body-copy'
    ]:
        try:
            found = soup.select(selector)
            if found:
                containers.extend(found)
        except Exception:
            pass
    if not containers:
        containers = [soup.body or soup]

    paras: list[str] = []
    seen: set[str] = set()
    for container in containers:
        for p in container.find_all(['p', 'h2', 'h3', 'blockquote'], limit=180):
            txt = _clean_source_text(p.get_text(' ', strip=True))
            if len(txt) < 40:
                continue
            low = txt.lower()
            if low in seen:
                continue
            if low.startswith('copyright ') or 'all rights reserved' in low:
                continue
            seen.add(low)
            paras.append(txt)
        if len(paras) >= 24:
            break

    if len(' '.join(paras)) < 500:
        body_text = _clean_source_text(ld_article.get('articleBody') or '')
        if len(body_text) >= 280:
            chunks = re.split(r'(?<=[.!?])\s+(?=[A-Z"“])', body_text)
            paras = [chunk.strip() for chunk in chunks if len(chunk.strip()) >= 40][:18] or [body_text[:2000]]

    lowered = (html_text or '').lower()
    block_indicators = [
        'access to this page has been denied',
        'access to this page has been blocked',
        'please enable javascript',
        'enable javascript to continue',
        'captcha',
        'verify you are human',
        'just a moment...',
        'cloudflare',
        'bot verification',
    ]
    is_blocked = any(x in lowered for x in block_indicators)

    total_chars = len(' '.join(paras))
    quality = 'reader'
    if is_blocked or total_chars < 280:
        quality = 'redirect'
    elif total_chars < 700:
        quality = 'thin'

    return {
        'title': title,
        'description': desc,
        'image': image,
        'paragraphs': paras[:18],
        'is_blocked': is_blocked,
        'quality': quality,
        'total_chars': total_chars,
    }


def _render_source_reader_page(source: str, title: str, original_url: str, final_url: str, article: dict[str, Any], note: str = '') -> str:
    safe_source = html.escape(source or 'Source')
    safe_title = html.escape((article.get('title') or title or original_url or 'Open source').strip())
    safe_original = html.escape(original_url)
    safe_final = html.escape(final_url or original_url)
    safe_note = html.escape(note) if note else ''
    desc = html.escape(article.get('description') or '')
    image = html.escape(article.get('image') or '')
    paras = ''.join(f'<p>{html.escape(p)}</p>' for p in (article.get('paragraphs') or []))
    if not paras:
        paras = '<p>We could not extract a clean readable copy for this source right now, but the original link is preserved below.</p>'
    image_html = ''
    if image:
        image_html = (
            '<img src="' + image + '" alt="" '
            'style="width:100%;max-height:320px;object-fit:cover;border-radius:18px;'
            'border:1px solid rgba(15,23,42,.08);margin:0 0 18px 0;" />'
        )
    note_html = f'<div style="margin-top:14px;color:#64748b;font-size:14px;line-height:1.5;">{safe_note}</div>' if safe_note else ''
    desc_html = f'<div style="font-size:18px;line-height:1.6;color:#334155;margin:0 0 18px;">{desc}</div>' if desc else ''
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{safe_title}</title>
<style>
body{{margin:0;background:#f3f4f6;color:#0f172a;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;}}
.wrap{{max-width:920px;margin:32px auto;padding:0 18px;}}
.card{{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:28px;box-shadow:0 16px 48px rgba(15,23,42,.08);padding:24px;}}
.kicker{{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;background:#eef2ff;border:1px solid rgba(59,130,246,.14);font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#334155;}}
h1{{margin:14px 0 10px;font-size:clamp(30px,4vw,54px);line-height:1.02;letter-spacing:-.04em;}}
.meta{{font-size:14px;color:#64748b;word-break:break-all;}}
.actions{{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 20px;}}
.btn{{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 18px;border-radius:999px;border:1px solid rgba(15,23,42,.12);font-weight:800;text-decoration:none;}}
.btn.primary{{background:#0f172a;color:#fff;border-color:#0f172a;}}
.content{{font-size:18px;line-height:1.72;color:#1e293b;}}
.content p{{margin:0 0 16px;}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="kicker">{safe_source}</div>
      <h1>{safe_title}</h1>
      <div class="meta">{safe_final}</div>
      <div class="actions">
        <a class="btn primary" href="{safe_original}" target="_blank" rel="noopener noreferrer">Open original site</a>
      </div>
      {image_html}
      {desc_html}
      <div class="content">{paras}</div>
      {note_html}
    </div>
  </div>
</body>
</html>'''


@router.get('/api/source/go')
def source_go(url: str, title: str = '', source: str = ''):
    safe_url = _source_allowed_url(url)
    source_name = (source or urllib.parse.urlparse(safe_url).netloc or 'Source').strip()
    title_text = (title or '').strip()

    try:
        with requests.Session() as sess:
            resp = sess.get(safe_url, headers=_source_browser_headers(safe_url), timeout=12, allow_redirects=True)
            final_url = str(resp.url or safe_url)
            content_type = str(resp.headers.get('content-type') or '').lower()
            if resp.status_code >= 400 or 'text/html' not in content_type:
                raise RuntimeError(f'upstream status {resp.status_code}')
            article = _extract_readable_article(resp.text, final_url)
            quality = str(article.get('quality') or 'redirect').strip().lower()
            if quality == 'redirect':
                return RedirectResponse(url=final_url or safe_url, status_code=307)
            note = ''
            if quality == 'thin':
                note = 'This source only exposed a partial readable copy, so CHECKNE opened the best safe extraction available instead of showing a blank page.'
            return HTMLResponse(_render_source_reader_page(source_name, title_text, safe_url, final_url, article, note=note))
    except Exception:
        return RedirectResponse(url=safe_url, status_code=307)


@router.get('/api/source/open')
def source_open(url: str, title: str = '', source: str = ''):
    safe_url = _source_allowed_url(url)
    go_url = (
        '/api/source/go?url=' + urllib.parse.quote(safe_url, safe='') +
        '&title=' + urllib.parse.quote(title or '', safe='') +
        '&source=' + urllib.parse.quote(source or '', safe='')
    )
    return RedirectResponse(url=go_url, status_code=307)
