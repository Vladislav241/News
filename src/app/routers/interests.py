from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Request

from ..db import db

router = APIRouter()

# Trending topics are "topic-like" chips (short labels) derived from recent clusters.
# This is deterministic and lightweight (no user tracking required).
DEFAULT_LIMIT = 8
LOOKBACK_HOURS = 12  # recent window for "what's hot now"

STOPWORDS = {
    "the","a","an","and","or","to","of","in","on","for","with","at","as","by",
    "from","after","before","into","over","under","about","amid","between",
    "what","we","know","so","far","live","updates","analysis","explainer",
    "says","say","said","new","more","how","why","could","may","might",
}

# Normalize / dedupe simple demonyms/adjectives
CANON_MAP = {
    "iranian": "Iran",
    "israeli": "Israel",
    "russian": "Russia",
    "ukrainian": "Ukraine",
    "american": "US",
    "u.s.": "US",
    "u.s": "US",
    "us": "US",
}

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)

def _short_topic_from_title(title: str) -> str:
    """
    Convert a headline-ish title into a short topic label.
    Goal: "Trump", "Iran", "Russia-Ukraine war", "AI", "Germany".
    """
    t = (title or "").strip()
    if not t:
        return ""

    # Remove common prefix patterns
    t = re.sub(r'^\s*(what we know so far|live updates|analysis|explainer)\s*[:\-–—]?\s*', '', t, flags=re.I).strip()
    t = re.sub(r'\s+', ' ', t)

    # Prefer explicit "X–Y" conflicts
    m = re.search(r'\b([A-Z][a-z]+)\s*[-–—]\s*([A-Z][a-z]+)\b', t)
    if m:
        left, right = m.group(1), m.group(2)
        if re.search(r'\bwar\b', t, flags=re.I):
            return f"{left}-{right} war"
        return f"{left}-{right}"

    # Collect candidate tokens: capitalized words, acronyms, known entities
    tokens: list[str] = []
    for tok in re.findall(r"[A-Za-z][A-Za-z\.\-']+", t):
        raw = tok.strip(".'")
        if not raw:
            continue
        low = raw.lower()
        if low in STOPWORDS:
            continue

        if low in CANON_MAP:
            raw = CANON_MAP[low]
            low = raw.lower()

        is_acronym = raw.isupper() and 2 <= len(raw) <= 6
        is_cap = (raw[0].isupper() and raw[1:].islower()) if len(raw) > 1 else raw[0].isupper()
        if is_acronym or is_cap:
            tokens.append(raw)

    # De-dupe while preserving order
    seen: set[str] = set()
    uniq: list[str] = []
    for x in tokens:
        k = x.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(x)

    if not uniq:
        words = [w for w in re.findall(r"[a-zA-Z]+", t) if w.lower() not in STOPWORDS]
        if not words:
            return ""
        return words[0].title()

    # Make 1–2 word label
    label = uniq[0]
    if label == "US" and len(uniq) >= 2:
        label = uniq[1]

    if len(uniq) >= 2 and len(label) < 10:
        cand = uniq[1]
        if cand not in {"US"} and cand.lower() != label.lower():
            if len(f"{label} {cand}") <= 18:
                label = f"{label} {cand}"

    return label.strip()

def _topic_key(label: str) -> str:
    s = (label or "").strip().lower()
    s = s.replace("’", "'")
    s = re.sub(r"[^\w\s\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if s in CANON_MAP:
        s = CANON_MAP[s].lower()
    return s


@router.get("/api/interests/trending")
def trending_interests(
    request: Request,
    country: str = "world",
    language: str = "all",
    interests: str = "general",
    ui_lang: str = "en",
    limit: int = DEFAULT_LIMIT,
):
    """
    Returns topic-like trending chips.

    Response:
      { "items": [ { "label": str, "q": str, "score": float } ] }
    """
    try:
        limit = int(limit)
    except Exception:
        limit = DEFAULT_LIMIT
    limit = max(2, min(12, limit))

    interests_list = [x.strip().lower() for x in (interests or "").split(",") if x.strip()]
    if not interests_list:
        interests_list = ["general"]

    since_iso = (_now_utc() - timedelta(hours=LOOKBACK_HOURS)).isoformat()

    clusters = db.query_clusters(
        interests=interests_list,
        country=(country or "world"),
        language=(language or "all"),
        since_iso=since_iso,
        limit=200,
    )

    def score_cluster(c: dict[str, Any]) -> float:
        outlets = 0
        try:
            outlets = int(c.get("outlets_count") or c.get("sources_count") or 0)
        except Exception:
            outlets = 0
        ts = c.get("updated_at") or c.get("latest_published_at") or c.get("created_at")
        rec = 0.0
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            age_h = max(0.0, (_now_utc() - dt).total_seconds() / 3600.0)
            rec = max(0.0, 1.0 - (age_h / LOOKBACK_HOURS))
        except Exception:
            rec = 0.0
        return outlets * 10.0 + rec

    clusters_sorted = sorted(clusters, key=score_cluster, reverse=True)

    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    for c in clusters_sorted:
        title = (c.get("title") or c.get("cluster_title") or c.get("name") or "").strip()
        if not title:
            continue

        label = _short_topic_from_title(title)
        if not label:
            continue

        k = _topic_key(label)
        if not k or k in seen:
            continue
        seen.add(k)

        items.append({
            "label": label,
            "q": label,  # client-side search uses this query
            "score": float(score_cluster(c)),
        })
        if len(items) >= limit:
            break

    return {"items": items}
