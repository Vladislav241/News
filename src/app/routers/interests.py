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

TOPIC_LABELS = {
    "de": {
        "Iran-Israel tensions": "Iran-Israel-Spannungen",
        "Israel-Gaza war": "Israel-Gaza-Krieg",
        "Russia-Ukraine war": "Russland-Ukraine-Krieg",
        "China-Taiwan tensions": "China-Taiwan-Spannungen",
        "European Union": "Europäische Union",
        "United Nations": "Vereinte Nationen",
        "US election": "US-Wahl",
        "Inflation": "Inflation",
        "Interest rates": "Zinssätze",
        "Global economy": "Weltwirtschaft",
        "Energy": "Energie",
        "AI": "KI",
        "Crypto": "Krypto",
        "Cybersecurity": "Cybersicherheit",
        "Climate": "Klima",
        "Public health": "Öffentliche Gesundheit",
        "United States": "Vereinigte Staaten",
        "United Kingdom": "Vereinigtes Königreich",
        "China": "China",
        "India": "Indien",
        "Germany": "Deutschland",
        "France": "Frankreich",
        "Japan": "Japan",
        "NATO": "NATO",
    },
    "fr": {
        "Iran-Israel tensions": "Tensions Iran-Israël",
        "Israel-Gaza war": "Guerre Israël-Gaza",
        "Russia-Ukraine war": "Guerre Russie-Ukraine",
        "China-Taiwan tensions": "Tensions Chine-Taïwan",
        "European Union": "Union européenne",
        "United Nations": "Nations unies",
        "US election": "Élection américaine",
        "Inflation": "Inflation",
        "Interest rates": "Taux d’intérêt",
        "Global economy": "Économie mondiale",
        "Energy": "Énergie",
        "AI": "IA",
        "Crypto": "Crypto",
        "Cybersecurity": "Cybersécurité",
        "Climate": "Climat",
        "Public health": "Santé publique",
        "United States": "États-Unis",
        "United Kingdom": "Royaume-Uni",
        "China": "Chine",
        "India": "Inde",
        "Germany": "Allemagne",
        "France": "France",
        "Japan": "Japon",
        "NATO": "OTAN",
    },
}

def _translate_topic_label(label: str, ui_lang: str) -> str:
    lang = (ui_lang or "en").strip().lower()
    return TOPIC_LABELS.get(lang, {}).get(label, label)

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)

def _extract_topics_from_title(title: str) -> list[str]:
    """
    Extract "global" trending topics from a cluster title.

    IMPORTANT:
    - We intentionally avoid free-form "first capitalized word" heuristics,
      because they produce junk like "Big", "Now", "Cruise", library names, or surnames.
    - Instead we use a lightweight, deterministic taxonomy based on keyword patterns.
    """
    t = (title or "").strip()
    if not t:
        return []
    low = t.lower()

    # Normalize punctuation & common variants
    low = low.replace("’", "'")
    low = re.sub(r"\s+", " ", low)

    topics: list[str] = []

    # --- Conflicts / geopolitics (highest priority) ---
    if re.search(r"\b(iran|tehran)\b", low) and re.search(r"\b(israel|israeli|gaza|hamas|hezbollah|lebanon)\b", low):
        topics.append("Iran-Israel tensions")
    if re.search(r"\b(israel|israeli)\b", low) and re.search(r"\b(gaza|hamas|rafah|palestin)\b", low):
        topics.append("Israel-Gaza war")
    if re.search(r"\b(russia|russian|moscow|kremlin)\b", low) and re.search(r"\b(ukraine|ukrainian|kyiv|kiev)\b", low):
        topics.append("Russia-Ukraine war")
    if re.search(r"\b(taiwan)\b", low) and re.search(r"\b(china|chinese|beijing)\b", low):
        topics.append("China-Taiwan tensions")
    if re.search(r"\b(nato)\b", low):
        topics.append("NATO")
    if re.search(r"\b(eu|european union|brussels)\b", low):
        topics.append("European Union")
    if re.search(r"\b(un|united nations)\b", low):
        topics.append("United Nations")

    # --- US / elections ---
    if re.search(r"\b(election|primary|campaign|ballot|vote|voting)\b", low) and re.search(r"\b(us|u\.s\.|america|american|white house|biden|trump|democrat|republican)\b", low):
        topics.append("US election")

    # --- Economy / markets ---
    if re.search(r"\b(inflation|cpi|prices|cost of living)\b", low):
        topics.append("Inflation")
    if re.search(r"\b(interest rate|rates|fed|ecb|central bank|bond yields?)\b", low):
        topics.append("Interest rates")
    if re.search(r"\b(recession|gdp|jobs report|unemployment|economy)\b", low):
        topics.append("Global economy")
    if re.search(r"\b(oil|gas|brent|wti|opec)\b", low):
        topics.append("Energy")

    # --- Tech ---
    if re.search(r"\b(ai|artificial intelligence|chatgpt|openai|gpt|llm|deepmind)\b", low):
        topics.append("AI")
    if re.search(r"\b(bitcoin|crypto|cryptocurrency|ethereum|solana|blockchain)\b", low):
        topics.append("Crypto")
    if re.search(r"\b(cyber|ransomware|hack|hacker|breach|data leak)\b", low):
        topics.append("Cybersecurity")

    # --- Climate / health ---
    if re.search(r"\b(climate|global warming|emissions|cop\d+|carbon)\b", low):
        topics.append("Climate")
    if re.search(r"\b(pandemic|who|virus|outbreak|covid|avian flu|h5n1)\b", low):
        topics.append("Public health")

    # If nothing matched, do a conservative fallback to a small set of truly-global countries/regions.
    if not topics:
        major = [
            ("United States", r"\b(us|u\.s\.|united states|america|american)\b"),
            ("United Kingdom", r"\b(uk|u\.k\.|britain|british|england|london)\b"),
            ("China", r"\b(china|chinese|beijing)\b"),
            ("India", r"\b(india|indian)\b"),
            ("Germany", r"\b(germany|german|berlin)\b"),
            ("France", r"\b(france|french|paris)\b"),
            ("Japan", r"\b(japan|japanese|tokyo)\b"),
        ]
        for label, pat in major:
            if re.search(pat, low):
                topics.append(label)
                break

    # De-dupe while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for x in topics:
        k = x.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def _best_topic_for_cluster(title: str) -> str:
    # Prefer the first (highest-priority) topic from the taxonomy.
    topics = _extract_topics_from_title(title)
    return topics[0] if topics else ""

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
        language="all",
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

        label = _best_topic_for_cluster(title)
        if not label:
            continue

        k = _topic_key(label)
        if not k or k in seen:
            continue
        seen.add(k)

        items.append({
            "label": _translate_topic_label(label, ui_lang),
            "q": label,  # keep canonical English query for stable backend matching
            "score": float(score_cluster(c)),
        })
        if len(items) >= limit:
            break

    return {"items": items}
