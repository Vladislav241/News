from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

from .ai import summarize_cluster
from .clustering import canonical_cluster_key, match_cluster, normalize_title_for_key, begin_llm_budget_window, get_llm_budget_stats
from .db import db
from .video_report import prefetch_video_reports_for_clusters
from .scoring import compute_credibility

logger = logging.getLogger("news.ingest")

# =========================================================
# RSS SOURCES
# =========================================================

DEFAULT_RSS_SOURCES: dict[str, Any] = {
    "world": {
        "en": {
            "general": [
                {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
                {"name": "CNN Top Stories", "url": "https://rss.cnn.com/rss/cnn_topstories.rss"},
                {"name": "Reuters World", "url": "https://www.reuters.com/world/rss"},
                {"name": "The Guardian World", "url": "https://www.theguardian.com/world/rss"},
                {"name": "AP Top News", "url": "https://apnews.com/hub/ap-top-news?output=rss"},
                {"name": "France24 EN", "url": "https://www.france24.com/en/rss"},
                {"name": "Politico Europe", "url": "https://www.politico.eu/feed/"},
            ],
            "business": [
                {"name": "Reuters Business", "url": "https://www.reuters.com/business/rss"},
                {"name": "Bloomberg", "url": "https://feeds.bloomberg.com/markets/news.rss"},
                {"name": "CNBC", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},
            ],
            "technology": [
                {"name": "BBC Technology", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml"},
                {"name": "The Verge", "url": "https://www.theverge.com/rss/index.xml"},
                {"name": "TechCrunch", "url": "https://techcrunch.com/feed/"},
            ],
            "politics": [
                {"name": "Politico", "url": "https://www.politico.com/rss/politics08.xml"},
                {"name": "The Hill", "url": "https://thehill.com/feed/"},
            ],
        }
    },
    "us": {
        "en": {
            "general": [
                {"name": "NYTimes U.S.", "url": "https://rss.nytimes.com/services/xml/rss/nyt/US.xml"},
                {"name": "Washington Post", "url": "https://feeds.washingtonpost.com/rss/rss_the-front-page"},
                {"name": "Reuters U.S.", "url": "https://www.reuters.com/world/us/rss"},
                {"name": "NPR News", "url": "https://feeds.npr.org/1001/rss.xml"},
                {"name": "ABC News", "url": "https://abcnews.go.com/abcnews/topstories"},
            ],
            "business": [
                {"name": "NYTimes Business", "url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"},
                {"name": "CNBC Markets", "url": "https://www.cnbc.com/id/10001147/device/rss/rss.html"},
            ],
            "politics": [
                {"name": "NYTimes Politics", "url": "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml"},
                {"name": "Politico", "url": "https://www.politico.com/rss/politics08.xml"},
            ],
        }
    },
    "gb": {
        "en": {
            "general": [
                {"name": "BBC UK", "url": "https://feeds.bbci.co.uk/news/uk/rss.xml"},
                {"name": "The Guardian UK", "url": "https://www.theguardian.com/uk-news/rss"},
                {"name": "Sky News UK", "url": "https://feeds.skynews.com/feeds/rss/uk.xml"},
                {"name": "Independent UK", "url": "https://www.independent.co.uk/news/uk/rss"},
            ],
            "business": [
                {"name": "BBC Business", "url": "https://feeds.bbci.co.uk/news/business/rss.xml"},
                {"name": "Guardian Business", "url": "https://www.theguardian.com/business/rss"},
            ],
            "politics": [
                {"name": "BBC Politics", "url": "https://feeds.bbci.co.uk/news/politics/rss.xml"},
                {"name": "The Guardian Politics", "url": "https://www.theguardian.com/politics/rss"},
            ],
        }
    },
    "de": {
        "de": {
            "general": [
                {"name": "Tagesschau", "url": "https://www.tagesschau.de/xml/rss2/"},
                {"name": "Spiegel Top", "url": "https://www.spiegel.de/schlagzeilen/tops/index.rss"},
                {"name": "Zeit Online", "url": "https://newsfeed.zeit.de/index"},
                {"name": "Sueddeutsche Top", "url": "https://rss.sueddeutsche.de/rss/Topthemen"},
            ],
            "business": [
                {"name": "Handelsblatt", "url": "https://www.handelsblatt.com/contentexport/feed/news"},
                {"name": "Tagesschau Wirtschaft", "url": "https://www.tagesschau.de/wirtschaft/index~rss2.xml"},
            ],
            "technology": [
                {"name": "Heise News", "url": "https://www.heise.de/rss/heise-atom.xml"},
            ],
            "politics": [
                {"name": "Tagesschau Inland", "url": "https://www.tagesschau.de/inland/index~rss2.xml"},
            ],
        },
        "en": {
            "general": [
                {"name": "DW English Germany", "url": "https://rss.dw.com/xml/rss-en-ger"},
                {"name": "Der Spiegel International", "url": "https://www.spiegel.de/international/index.rss"},
            ],
        },
    },
    "fr": {
        "fr": {
            "general": [
                {"name": "Le Monde", "url": "https://www.lemonde.fr/rss/une.xml"},
                {"name": "Le Monde France", "url": "https://www.lemonde.fr/france/rss_full.xml"},
                {"name": "France24 FR", "url": "https://www.france24.com/fr/rss"},
                {"name": "Le Figaro", "url": "https://www.lefigaro.fr/rss/figaro_actualites.xml"},
            ],
            "business": [
                {"name": "Le Monde Economie", "url": "https://www.lemonde.fr/economie/rss_full.xml"},
                {"name": "Le Figaro Economie", "url": "https://www.lefigaro.fr/rss/figaro_economie.xml"},
            ],
            "politics": [
                {"name": "Le Figaro Politique", "url": "https://www.lefigaro.fr/rss/figaro_politique.xml"},
            ],
        },
        "en": {
            "general": [
                {"name": "France24 EN", "url": "https://www.france24.com/en/rss"},
            ],
        },
    },
}

SIMILARITY_THRESHOLD = 0.33


def _parse_iso_utc(value: str | None) -> datetime | None:
    s = (value or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _summary_source_fingerprint(sources: list[dict[str, Any]]) -> str:
    rows: list[tuple[str, str, str, str]] = []
    for s in (sources or []):
        src = (s.get("source_name") or "").strip().lower()
        title = (s.get("title") or "").strip().lower()
        url = (s.get("url") or "").strip()
        published = (s.get("published_at") or "").strip()
        if not (src or title or url):
            continue
        rows.append((src[:120], title[:220], url[:240], published[:40]))
    rows.sort()
    payload = json.dumps(rows[:16], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8", errors="ignore")).hexdigest()


def _should_refresh_summary(cluster_id: int, sources: list[dict[str, Any]], min_interval_seconds: int) -> tuple[bool, str, str, int]:
    uniq_sources = {
        (s.get("source_name") or "").strip().lower()
        for s in (sources or [])
        if (s.get("source_name") or "").strip()
    }
    source_count = len(uniq_sources)
    fingerprint = _summary_source_fingerprint(sources)
    existing = db.get_summary(int(cluster_id)) or {}
    if not existing:
        return True, "missing", fingerprint, source_count

    old_fp = (existing.get("source_fingerprint") or "").strip()
    old_count = int(existing.get("source_count") or 0)
    created_at = _parse_iso_utc(existing.get("created_at"))
    now = datetime.now(timezone.utc)

    current_status = (existing.get("status") or "").strip().lower()
    if current_status == "pending":
        if created_at and (now - created_at).total_seconds() < max(600, min_interval_seconds // 3):
            return False, "pending", fingerprint, source_count
        return True, "pending_stale", fingerprint, source_count

    if current_status != "success":
        retry_after_seconds = max(1800, min_interval_seconds)
        if old_fp and old_fp == fingerprint and created_at and (now - created_at).total_seconds() < retry_after_seconds:
            return False, "recent_failed", fingerprint, source_count
        if not created_at or (now - created_at).total_seconds() >= max(900, min_interval_seconds // 2):
            return True, "retry_failed", fingerprint, source_count
        return False, "recent_failed", fingerprint, source_count

    if old_fp and old_fp == fingerprint:
        return False, "fingerprint_unchanged", fingerprint, source_count

    if old_count != source_count and source_count >= max(2, old_count + 2):
        return True, "source_count_jump", fingerprint, source_count

    if created_at and (now - created_at).total_seconds() < min_interval_seconds:
        return False, "rate_limited", fingerprint, source_count

    return True, "fingerprint_changed", fingerprint, source_count

# =========================================================
# CLUSTERING GATES HELPERS (cheap, offline)
# =========================================================

import re as _re

_CAP_SEQ_RE = _re.compile(
    r"\b(?:[A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+){0,3}|[A-ZА-ЯЁ]{2,}(?:\s+[A-ZА-ЯЁ]{2,}){0,2})\b"
)
_NOISE = {"the", "and", "for", "with", "from", "says", "said", "new", "news", "live", "update", "breaking"}

_TITLE_SIG_STOP = {
    "the", "and", "for", "with", "from", "into", "after", "before", "amid", "over", "under", "against",
    "says", "said", "say", "new", "news", "live", "latest", "update", "updates", "breaking", "watch",
    "photos", "photo", "video", "videos", "story", "stories", "report", "reports", "analysis", "opinion",
    "world", "general", "english", "edition", "top", "headline", "headlines", "week", "today", "night",
    "morning", "afternoon", "evening", "hours", "hour", "minute", "minutes", "still", "more", "than",
    "their", "there", "about", "this", "that", "these", "those", "have", "has", "had", "been", "will",
}


def _title_signature_terms(text: str, limit: int = 12) -> set[str]:
    raw = (text or "").strip()
    if not raw:
        return set()
    norm = normalize_title_for_key(raw, "en") or ""
    if not norm:
        norm = _re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ\s]+", " ", raw.lower())
        norm = _re.sub(r"\s+", " ", norm).strip()
    out: list[str] = []
    for tok in norm.split():
        if len(tok) < 4 and not tok.isdigit():
            continue
        if tok in _TITLE_SIG_STOP or tok in _NOISE:
            continue
        if tok.isdigit() and len(tok) < 2:
            continue
        out.append(tok)
    if len(out) > limit:
        out = out[:limit]
    return set(out)


def _signature_overlap(a: set[str], b: set[str]) -> int:
    if not a or not b:
        return 0
    return len(a & b)


def _should_skip_candidate_by_title(
    article_title: str,
    article_desc: str,
    article_terms: set[str],
    article_entities: set[str],
    candidate_title_text: str,
    candidate_terms: set[str],
    candidate_entities: set[str],
) -> bool:
    """Hard offline gate that blocks cross-topic merges before TF-IDF runs.

    Main goal: stop clusters from being polluted by a single noisy source/description.
    We intentionally trust titles much more than descriptions here.
    """
    cand_title = (candidate_title_text or "").strip()
    if not cand_title:
        return False

    title_entities = _extract_entities(article_title)
    cand_title_entities = _extract_entities(cand_title)
    title_ent_overlap = len(title_entities & cand_title_entities)
    term_overlap = _signature_overlap(article_terms, candidate_terms)
    entity_overlap = len(article_entities & candidate_entities)

    # Strong disagreement between title anchors on both sides = almost certainly different stories.
    if len(article_terms) >= 2 and len(candidate_terms) >= 2 and term_overlap == 0 and title_ent_overlap == 0:
        if len(title_entities) >= 1 and len(cand_title_entities) >= 1:
            return True
        # When both sides have several strong title terms and no entity support, don't let descriptions glue them together.
        if len(article_terms) >= 3 and len(candidate_terms) >= 3:
            return True

    # If overall entities are rich on both sides but there is zero overlap and no shared title terms, reject.
    if len(article_entities) >= 3 and len(candidate_entities) >= 3 and entity_overlap == 0 and term_overlap == 0:
        return True

    # Short emergency titles can rely on description a bit, but only if there is at least one shared anchor.
    if len(article_terms) >= 1 and len(candidate_terms) >= 1 and term_overlap == 0 and title_ent_overlap == 0:
        desc_terms = _title_signature_terms(article_desc, limit=8)
        if desc_terms and len(desc_terms & candidate_terms) == 0 and entity_overlap == 0:
            return True

    return False


def _extract_entities(text: str) -> set[str]:
    if not text:
        return set()
    ents: set[str] = set()
    for m in _CAP_SEQ_RE.finditer(text):
        chunk = m.group(0).strip()
        parts = [w.strip(".") for w in chunk.split()]
        if len(parts) == 1 and len(parts[0]) < 4:
            continue
        norm = " ".join(parts).lower()
        if norm in _NOISE:
            continue
        ents.add(norm)
        for w in parts:
            lw = w.lower()
            if lw not in _NOISE and len(lw) >= 3:
                ents.add(lw)

    if len(ents) > 60:
        ents = set(sorted(ents, key=lambda x: (-len(x), x))[:60])
    return ents


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _parse_iso_dt(s: str | None):
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# =========================================================
# RSS TEXT SANITIZATION
# =========================================================

_CUT_MARKERS = [
    "what to read next",
    "recommended stories",
    "recommended",
    "related",
    "more on this story",
    "read more",
    "go deeper",
]


def _is_headline_like(line: str) -> bool:
    if not line:
        return False
    s = line.strip()
    if len(s) < 25 or len(s) > 140:
        return False

    words = [w for w in _re.split(r"\s+", s) if w]
    if len(words) < 4:
        return False

    caps = sum(1 for w in words if (w[:1].isupper() and w[1:].islower()))
    allcaps = sum(1 for w in words if w.isupper() and len(w) >= 3)

    if ":" in s or " — " in s or " - " in s:
        return True
    if allcaps >= 2:
        return True
    if caps / max(1, len(words)) >= 0.6:
        return True
    return False


def _clean_rss_html(text: str) -> str:
    if not text:
        return ""
    t = text.strip()

    # If it's HTML, extract first real paragraph and ignore promo/link lists.
    if "<" in t and ">" in t:
        try:
            soup = BeautifulSoup(t, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                tag.decompose()
            p = soup.find("p")
            if p:
                t = p.get_text(" ", strip=True)
            else:
                t = soup.get_text(" ", strip=True)
        except Exception:
            t = BeautifulSoup(t, "html.parser").get_text(" ", strip=True)

    low = t.lower()
    cut_at = None
    for m in _CUT_MARKERS:
        idx = low.find(m)
        if idx != -1:
            cut_at = idx if cut_at is None else min(cut_at, idx)
    if cut_at is not None and cut_at > 0:
        t = t[:cut_at].strip()

    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    if len(lines) > 1:
        bulletish = sum(1 for ln in lines[1:] if ln.startswith(("•", "-", "*")))
        if bulletish >= 1:
            t = lines[0]

    if len(t) > 450:
        t = t[:450].rsplit(" ", 1)[0].strip() + "…"
    return t


def _safe_entry_text(entry: Any) -> tuple[str, str, str]:
    title = (getattr(entry, "title", None) or "").strip()
    desc = (getattr(entry, "summary", None) or getattr(entry, "description", None) or "").strip()
    content = ""

    try:
        if getattr(entry, "content", None):
            content = (entry.content[0].value or "").strip()
    except Exception:
        content = ""

    return title, _clean_rss_html(desc), _clean_rss_html(content)


def _guess_title_from_url(url: str) -> str:
    """Fallback title when RSS entry title is missing/broken."""
    u = (url or "").strip()
    if not u:
        return ""
    try:
        u = u.split("#", 1)[0].split("?", 1)[0]
        parts = [p for p in u.split("/") if p]
        if not parts:
            return ""
        slug = parts[-1]
        if slug.lower() in {"rss", "feed"} and len(parts) >= 2:
            slug = parts[-2]
        slug = slug.replace("-", " ").replace("_", " ").strip()
        slug = _re.sub(r"\s+", " ", slug)
        return slug[:180].strip()
    except Exception:
        return ""


# --- clustering safety: avoid catastrophic cross-topic merges on low-signal titles ---
# Some feeds occasionally emit items with missing/garbled <title> ("Live", "Photos", "Watch", "World"),
# or extremely generic gallery headlines. If we generate a shared cluster_key from such text, unrelated
# stories can get glued together and then "snowball" (the cluster becomes a magnet for more bad merges).
#
# Strategy:
# - If the normalized title looks low-signal AND the raw title has no clear anchors (entities/digits),
#   fall back to a per-URL hash cluster key.
# This may increase the number of separate clusters for very short/garbled headlines, but it prevents
# the much worse UX of unrelated sources appearing inside the same cluster.
_LOW_SIGNAL_TOKENS = {
    # common feed boilerplate / gallery wording
    "live", "updates", "update", "breaking", "analysis", "opinion", "photos", "photo", "videos", "video",
    "watch", "listen", "read", "latest", "today", "top", "highlights", "gallery", "images",
    # overly generic section labels
    "world", "news", "general",
}


def _has_anchor_in_raw_title(raw_title: str) -> bool:
    t = (raw_title or "").strip()
    if not t:
        return False
    # Digits (years, counts, etc.) are often strong discriminators.
    if _re.search(r"\d", t):
        return True
    # Proper-noun-like tokens (e.g. Trump, Iran, Kyiv) are anchors.
    # Keep this intentionally simple and language-agnostic.
    if _re.search(r"\b[A-ZА-ЯЁ][a-zа-яё]{2,}\b", t):
        return True
    return False


def _is_low_signal_norm_title(norm_title: str, raw_title: str) -> bool:
    nt = (norm_title or "").strip()
    if not nt:
        return True

    toks = nt.split()
    if len(toks) <= 3:
        # Allow short titles ONLY if they have an anchor (e.g. a named entity or digits).
        return not _has_anchor_in_raw_title(raw_title)

    # If most tokens are boilerplate, treat as low-signal.
    content = [t for t in toks if t not in _LOW_SIGNAL_TOKENS]
    if len(content) <= 3:
        return True

    # Very short normalized strings are risky (often just "photos videos" etc.).
    if len(nt) < 18 and not _has_anchor_in_raw_title(raw_title):
        return True

    return False


def _guess_title_from_desc(desc: str) -> str:
    """Fallback title from description/summary."""
    d = (desc or "").strip()
    if not d:
        return ""
    d = d.replace("\n", " ").replace("\r", " ")
    d = _re.sub(r"\s+", " ", d).strip()
    cut = None
    for sep in [". ", "…", " - ", " — ", " | "]:
        idx = d.find(sep)
        if idx != -1:
            cut = idx if cut is None else min(cut, idx)
    if cut is not None and cut > 20:
        d = d[:cut].strip()
    return d[:180].strip()


# =========================================================
# LIVEBLOG ISOLATION
# =========================================================

_LIVEBLOG_URL_RE = _re.compile(r"(/live/|/liveblog/|/live-updates/|/live-updates$)", _re.IGNORECASE)
_LIVEBLOG_TITLE_RE = _re.compile(r"\b(live updates?|liveblog|live blog|latest news updates)\b", _re.IGNORECASE)


def _is_liveblog(url: str | None, title: str | None) -> bool:
    u = (url or "").strip().lower()
    t = (title or "").strip().lower()
    if not u and not t:
        return False
    if u:
        try:
            u = u.split("#", 1)[0]
            u = u.split("?", 1)[0]
        except Exception:
            pass
        if _LIVEBLOG_URL_RE.search(u):
            return True
        if "theguardian.com" in u and "/live/" in u:
            return True
    if t and _LIVEBLOG_TITLE_RE.search(t):
        return True
    if t.startswith(("live:", "live -", "live —", "live updates:")):
        return True
    return False


def _liveblog_cluster_key(language: str, url: str) -> str:
    u = (url or "").strip()
    try:
        u = u.split("#", 1)[0]
        u = u.split("?", 1)[0]
    except Exception:
        pass
    base = f"live::{(language or 'en').lower()}::{u.lower()}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


# =========================================================
# FULL ARTICLE EXTRACTION (background queue uses this)
# =========================================================

_ARTICLE_CACHE: dict[str, tuple[float, str]] = {}
_ARTICLE_CACHE_TTL_SEC = 60 * 30


def _now_ts() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0


def _looks_contaminated(text: str) -> bool:
    if not text:
        return True
    low = text.lower()
    if any(m in low for m in _CUT_MARKERS):
        return True
    if any(m in low for m in ("most popular", "popular", "trending", "you might also", "more stories", "more from", "advertisement")):
        return True
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) >= 3:
        headlineish = 0
        for ln in lines[1:]:
            if _is_headline_like(ln):
                headlineish += 1
        if headlineish >= 2:
            return True
    return False


def _should_fetch_full_article(source_name: str, desc: str, content: str) -> bool:
    sn = (source_name or "").lower()
    if sn in {"the hill", "the guardian world", "the guardian"}:
        return True
    t = (desc or "") + " " + (content or "")
    if _looks_contaminated(t):
        return True
    if len((desc or "").strip()) < 120 and len((content or "").strip()) < 200:
        return True
    return False


def _sentences(text: str) -> list[str]:
    t = (text or "").strip()
    if not t:
        return []
    parts = _re.split(r"(?<=[.!?])\s+", t)
    out: list[str] = []
    for s in parts:
        s = s.strip()
        if len(s) >= 30:
            out.append(s)
        if len(out) >= 5:
            break
    return out


def _extract_from_jsonld(soup: BeautifulSoup) -> str | None:
    scripts = soup.find_all("script", type=_re.compile(r"application/ld\+json", _re.I))
    for sc in scripts[:20]:
        raw = (sc.string or sc.get_text() or "").strip()
        if not raw:
            continue
        try:
            blobs = [json.loads(raw)]
        except Exception:
            try:
                raw2 = raw.strip().strip(";")
                blobs = [json.loads(raw2)]
            except Exception:
                continue

        def walk(obj):
            if isinstance(obj, dict):
                yield obj
                for v in obj.values():
                    yield from walk(v)
            elif isinstance(obj, list):
                for it in obj:
                    yield from walk(it)

        for obj in walk(blobs):
            if not isinstance(obj, dict):
                continue
            typ = obj.get("@type") or obj.get("type")
            if isinstance(typ, list):
                typ = " ".join([str(x) for x in typ])
            typ_s = str(typ or "").lower()
            if any(k in typ_s for k in ("newsarticle", "article", "report")):
                body = obj.get("articleBody") or obj.get("text")
                if isinstance(body, str) and len(body.strip()) >= 400:
                    return body.strip()
                desc = obj.get("description")
                if isinstance(desc, str) and len(desc.strip()) >= 250:
                    return desc.strip()
    return None


def _link_text_len(node) -> int:
    try:
        return sum(len(a.get_text(" ", strip=True) or "") for a in node.find_all("a"))
    except Exception:
        return 0


def _best_container_text(soup: BeautifulSoup) -> str:
    candidates: list[tuple[int, Any]] = []
    for tag_name in ("article", "main"):
        for node in soup.find_all(tag_name):
            txt = node.get_text(" ", strip=True)
            if len(txt) >= 400:
                candidates.append((len(txt), node))
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1].get_text(" ", strip=True)

    best = ("", -1e18)
    for node in soup.find_all(["div", "section"]):
        txt = node.get_text(" ", strip=True)
        tl = len(txt)
        if tl < 500:
            continue
        ltd = _link_text_len(node)
        score = tl - 4 * ltd
        words = txt.split()
        if words:
            avg = sum(len(w) for w in words) / max(1, len(words))
            if avg < 4.0:
                score -= 400
        li = len(node.find_all("li"))
        if li >= 8:
            score -= 300
        if score > best[1]:
            best = (txt, score)
    return best[0] if best[0] else soup.get_text(" ", strip=True)


def _url_hash(url: str) -> str:
    u = (url or "").strip().split("#")[0]
    return hashlib.sha1(u.encode("utf-8")).hexdigest()


def _fetch_article_text(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""

    h = _url_hash(u)
    ts = _now_ts()
    cached = _ARTICLE_CACHE.get(h)
    if cached and (ts - cached[0]) < _ARTICLE_CACHE_TTL_SEC:
        return cached[1]

    headers = {
        "User-Agent": "Mozilla/5.0 (NewsAggregator; +https://example.invalid)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        resp = requests.get(u, timeout=8, headers=headers, allow_redirects=True)
        if resp.status_code != 200 or not resp.text:
            return ""
        html = resp.text
    except Exception:
        return ""

    try:
        soup = BeautifulSoup(html, "lxml")
        for tag in soup(["script", "style", "noscript", "svg", "canvas", "form", "nav", "footer", "header", "aside"]):
            tag.decompose()

        jsonld = _extract_from_jsonld(soup)
        if jsonld:
            text = jsonld
        else:
            ogd = soup.find("meta", property="og:description")
            og_text = (ogd.get("content") or "").strip() if ogd else ""
            main_text = _best_container_text(soup)
            text = main_text if len(main_text) >= 400 else (og_text or main_text)

        text = _clean_rss_html(text)
        if len(text) > 1800:
            text = text[:1800].rsplit(" ", 1)[0].strip() + "…"

        _ARTICLE_CACHE[h] = (ts, text)
        return text
    except Exception:
        return ""


# =========================================================
# BACKGROUND FULLTEXT JOBS (NON-BLOCKING)
# =========================================================


def _backoff_seconds(attempts: int) -> int:
    a = max(1, int(attempts))
    if a == 1:
        return 30
    if a == 2:
        return 120
    if a == 3:
        return 300
    return min(1200, 300 * a)


def process_fulltext_queue_once(max_jobs: int = 8, max_workers: int = 6) -> dict[str, Any]:
    db.ensure_schema()
    max_jobs = int(max(1, min(50, max_jobs)))
    max_workers = int(max(1, min(16, max_workers)))

    pending = db.list_fulltext_pending(limit=max_jobs)
    if not pending:
        return {"picked": 0, "done": 0, "failed": 0}

    claimed: list[dict[str, Any]] = []
    for row in pending:
        aid = int(row.get("id") or 0)
        if aid <= 0:
            continue
        if db.claim_fulltext_job(aid):
            claimed.append(row)

    if not claimed:
        return {"picked": 0, "done": 0, "failed": 0}

    from concurrent.futures import ThreadPoolExecutor, as_completed

    done = 0
    failed = 0

    def _work(item: dict[str, Any]) -> tuple[int, str, str, str | None]:
        aid = int(item.get("id") or 0)
        url = (item.get("url") or "").strip()
        if not url:
            return aid, "", "", "empty_url"
        text = _fetch_article_text(url)
        if not text or len(text) < 200:
            return aid, "", "", "no_text"
        ss = _sentences(text)
        desc = " ".join(ss[:2]).strip() if ss else ""
        return aid, desc, text, None

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [ex.submit(_work, it) for it in claimed]
        for fut in as_completed(futs):
            try:
                aid, desc, body, err = fut.result()
                if not err:
                    db.mark_fulltext_done(aid, desc, body)
                    done += 1
                else:
                    art = db.get_article_by_id(int(aid))
                    attempts = int(art.get("fulltext_attempts") or 0) + 1
                    db.mark_fulltext_failed(aid, err, _backoff_seconds(attempts))
                    failed += 1
            except Exception:
                failed += 1

    return {"picked": len(claimed), "done": done, "failed": failed}


# =========================================================
# IMAGE EXTRACTION
#
# Why images sometimes look low-quality:
# - Many RSS feeds include only thumbnails (media:thumbnail) or small variants.
# - The article page often has a higher quality social/hero image.
#
# We extract a fast RSS image first, then (budget-limited) upgrade it by fetching
# the article HTML and picking the best available image.
# =========================================================


_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def _abs_url(u: str, base: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    return urljoin(base, u)


def _parse_srcset(srcset: str, base_url: str) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    s = (srcset or "").strip()
    if not s:
        return out
    for part in s.split(","):
        chunk = part.strip()
        if not chunk:
            continue
        bits = chunk.split()
        u = _abs_url(bits[0], base_url)
        w = 0
        if len(bits) >= 2 and bits[1].endswith("w"):
            try:
                w = int(bits[1][:-1])
            except Exception:
                w = 0
        out.append((u, w))
    return out


def _wordpress_remove_size_suffix(u: str) -> str:
    # Common: .../image-150x150.jpg -> .../image.jpg
    try:
        parsed = urlparse(u)
        path = parsed.path
        path2 = _re.sub(r"-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp)$)", "", path, flags=_re.I)
        if path2 == path:
            return u
        return urlunparse(parsed._replace(path=path2))
    except Exception:
        return u


def _upgrade_resize_params(u: str, target_w: int = 1200) -> str:
    """Best-effort bump of common resize params (WordPress, etc.)."""
    try:
        parsed = urlparse(u)
        host = (parsed.netloc or "").lower()
        qs = parse_qs(parsed.query or "", keep_blank_values=True)

        # The Guardian image CDN (i.guim.co.uk) frequently uses *signed* URLs with a
        # query parameter "s". Touching any query parameter on signed URLs can make
        # the signature invalid -> 4xx -> broken images on the site.
        # So: never rewrite signed Guardian image URLs.
        if "i.guim.co.uk" in host and "s" in qs and qs.get("s"):
            return u

        # WordPress: ?resize=770%2C513
        if "resize" in qs and qs["resize"]:
            raw = qs["resize"][0]
            parts = [p for p in _re.split(r"[,x]", raw) if p]
            if parts:
                try:
                    w = int(parts[0])
                except Exception:
                    w = 0
                if 0 < w < target_w:
                    if len(parts) >= 2:
                        try:
                            h = int(parts[1])
                        except Exception:
                            h = 0
                        if h > 0 and w > 0:
                            new_h = max(1, int(h * (target_w / w)))
                            qs["resize"] = [f"{target_w},{new_h}"]
                        else:
                            qs["resize"] = [f"{target_w}"]
                    else:
                        qs["resize"] = [f"{target_w}"]
                    return urlunparse(parsed._replace(query=urlencode(qs, doseq=True)))

        # Generic: ?w=400 / ?width=400
        for key in ("w", "width"):
            if key in qs and qs[key]:
                try:
                    w = int(qs[key][0])
                except Exception:
                    w = 0
                if 0 < w < target_w:
                    qs[key] = [str(target_w)]
                    return urlunparse(parsed._replace(query=urlencode(qs, doseq=True)))
    except Exception:
        return u

    return u


def _normalize_image_candidate(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    u = _wordpress_remove_size_suffix(u)
    u = _upgrade_resize_params(u, target_w=1200)
    return u


def _is_probably_low_res(u: str) -> bool:
    s = (u or "").lower()
    if not s:
        return True
    if any(tok in s for tok in ("thumbnail", "thumb", "/thumb/", "small", "_small")):
        return True

    m = _re.search(r"-(\d{2,4})x(\d{2,4})(?=\.(?:jpe?g|png|webp)(?:\?|$))", s)
    if m:
        try:
            w = int(m.group(1))
        except Exception:
            w = 0
        if 0 < w < 600:
            return True

    try:
        parsed = urlparse(u)
        qs = parse_qs(parsed.query or "")
        if "resize" in qs and qs["resize"]:
            raw = qs["resize"][0]
            parts = [p for p in _re.split(r"[,x]", raw) if p]
            if parts:
                try:
                    w = int(parts[0])
                except Exception:
                    w = 0
                if 0 < w < 600:
                    return True
        for key in ("w", "width"):
            if key in qs and qs[key]:
                try:
                    w = int(qs[key][0])
                except Exception:
                    w = 0
                if 0 < w < 600:
                    return True
    except Exception:
        pass

    return False


def _extract_best_image_from_html(html: str, base_url: str) -> str | None:
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")

    # 1) Meta social tags (usually best)
    meta_keys = [
        ("property", "og:image"),
        ("property", "og:image:secure_url"),
        ("property", "og:image:url"),
        ("name", "twitter:image"),
        ("name", "twitter:image:src"),
        ("itemprop", "image"),
    ]
    for attr, key in meta_keys:
        tag = soup.find("meta", attrs={attr: key})
        if not tag:
            continue
        u = _abs_url((tag.get("content") or "").strip(), base_url)
        u = _normalize_image_candidate(u)
        if u:
            return u

    # 1.5) JSON-LD (many publishers, incl. Guardian opinion/comment)
    try:
        for script in soup.find_all("script", attrs={"type": "application/ld+json"})[:20]:
            raw = (script.string or script.get_text("", strip=True) or "").strip()
            if not raw:
                continue
            # JSON-LD can be a dict, list, or contain @graph
            try:
                data = json.loads(raw)
            except Exception:
                continue

            nodes: list[Any] = []
            if isinstance(data, list):
                nodes = data
            elif isinstance(data, dict):
                if isinstance(data.get("@graph"), list):
                    nodes = data.get("@graph") or []
                else:
                    nodes = [data]

            def _collect_images(obj: Any) -> list[str]:
                imgs: list[str] = []
                if not isinstance(obj, dict):
                    return imgs
                val = obj.get("image") or obj.get("thumbnailUrl")
                if isinstance(val, str):
                    imgs.append(val)
                elif isinstance(val, list):
                    for it in val:
                        if isinstance(it, str):
                            imgs.append(it)
                        elif isinstance(it, dict) and isinstance(it.get("url"), str):
                            imgs.append(it["url"])
                elif isinstance(val, dict) and isinstance(val.get("url"), str):
                    imgs.append(val["url"])
                return imgs

            best_ld: str | None = None
            for n in nodes:
                for cand in _collect_images(n):
                    u = _normalize_image_candidate(_abs_url(str(cand), base_url))
                    if u:
                        best_ld = u
                        break
                if best_ld:
                    break
            if best_ld:
                return best_ld
    except Exception:
        pass


    # 1b) JSON-LD (NYT/DW often store image here)
    try:
        import json as _json
        import re as _re

        for sc in soup.find_all("script", attrs={"type": "application/ld+json"}):
            raw = (sc.string or sc.get_text() or "").strip()
            if not raw:
                continue

            # Some pages embed multiple objects or extra text; try to isolate JSON.
            m = _re.search(r"(\{.*\}|\[.*\])", raw, flags=_re.S)
            if m:
                raw = m.group(1)

            data = _json.loads(raw)

            def _pick_img(o):
                if isinstance(o, dict):
                    for k in ("image", "thumbnailUrl"):
                        if k in o and o[k]:
                            v = o[k]
                            if isinstance(v, str):
                                return v
                            if isinstance(v, list) and v:
                                first = v[0]
                                if isinstance(first, str):
                                    return first
                                if isinstance(first, dict):
                                    u = first.get("url")
                                    if isinstance(u, str):
                                        return u
                            if isinstance(v, dict):
                                u = v.get("url")
                                if isinstance(u, str):
                                    return u
                    for vv in o.values():
                        got = _pick_img(vv)
                        if got:
                            return got
                elif isinstance(o, list):
                    for it in o:
                        got = _pick_img(it)
                        if got:
                            return got
                return None

            img = _pick_img(data)
            if isinstance(img, str):
                img = _abs_url(img.strip(), base_url)
                img = _normalize_image_candidate(img) if img else None
                if img:
                    return img
    except Exception:
        pass

    # 2) Fallback: search <picture>/<img> and pick largest srcset candidate (incl. lazy attrs)
    best: tuple[str, int] | None = None
    # picture source srcset often has the real candidates
    for source in soup.find_all("source")[:80]:
        srcset = (source.get("srcset") or source.get("data-srcset") or "").strip()
        if not srcset:
            continue
        cands = _parse_srcset(srcset, base_url)
        if cands:
            u, w = max(cands, key=lambda t: t[1])
            if u and w >= 600:
                best = (u, w) if (best is None or w > best[1]) else best

    for img in soup.find_all("img")[:80]:
        srcset = (img.get("srcset") or "").strip()
        if srcset:
            cands = _parse_srcset(srcset, base_url)
            if cands:
                u, w = max(cands, key=lambda t: t[1])
                if u and w >= 600:
                    best = (u, w) if (best is None or w > best[1]) else best
                    continue

        # Lazy-load patterns
        src = (
            (img.get("src") or "")
            or (img.get("data-src") or "")
            or (img.get("data-original") or "")
            or (img.get("data-lazy-src") or "")
            or (img.get("data-url") or "")
        )
        src = _abs_url(str(src).strip(), base_url)
        if src and src.lower().split("?", 1)[0].endswith(_IMG_EXTS):
            best = best or (src, 0)

    if best:
        return _normalize_image_candidate(best[0]) or None
    return None


def _extract_best_image_from_url(url: str) -> str | None:
    try:
        resp = requests.get(
            url,
            timeout=9,
            allow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        if resp.status_code != 200:
            return None
        return _extract_best_image_from_html(resp.text or "", url)
    except Exception:
        return None


def _extract_image_url(entry: Any) -> str | None:
    """Fast image extraction from RSS only."""
    try:
        if getattr(entry, "enclosures", None):
            for e in entry.enclosures:
                href = (getattr(e, "href", None) or "").strip()
                typ = (getattr(e, "type", None) or "").strip().lower()
                if href and (typ.startswith("image") or href.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))):
                    return _normalize_image_candidate(href) or href

        media_content = getattr(entry, "media_content", None)
        if media_content:
            for m in media_content:
                u = (m.get("url") or "").strip()
                if u:
                    return _normalize_image_candidate(u) or u

        media_thumb = getattr(entry, "media_thumbnail", None)
        if media_thumb:
            for m in media_thumb:
                u = (m.get("url") or "").strip()
                if u:
                    return _normalize_image_candidate(u) or u

        links = getattr(entry, "links", None) or []
        for l in links:
            href = (l.get("href") or "").strip()
            typ = (l.get("type") or "").strip().lower()
            if not href:
                continue
            looks_like_img = href.lower().split("?", 1)[0].endswith((".jpg", ".jpeg", ".png", ".webp"))
            if looks_like_img and (typ.startswith("image") or typ == ""):
                return _normalize_image_candidate(href) or href

        # Many feeds (including The Guardian) embed a lead image directly inside
        # the entry HTML (content:encoded / content.value / summary). Feedparser
        # doesn't always map that to media:content.
        # This is still "RSS-only" because we don't make external requests here.
        try:
            base_url = (getattr(entry, "link", None) or "").strip() or ""
            html_bits: list[str] = []

            # feedparser: entry.content is usually a list of dicts with "value"
            cont = getattr(entry, "content", None)
            if isinstance(cont, list):
                for it in cont[:3]:
                    if isinstance(it, dict) and isinstance(it.get("value"), str):
                        html_bits.append(it.get("value") or "")

            # summary/detail often contains HTML
            summ = (getattr(entry, "summary", None) or getattr(entry, "description", None) or "")
            if isinstance(summ, str) and summ:
                html_bits.append(summ)

            for raw_html in html_bits:
                cand = _extract_best_image_from_html(raw_html or "", base_url or "")
                if cand:
                    return cand
        except Exception:
            pass
    except Exception:
        return None


def backfill_article_images(*, days: int = 365, limit: int = 200, budget: int = 25) -> dict[str, Any]:
    """Backfill missing article images by scraping the article page for a good image.

    Why this exists:
      - RSS image extraction isn't consistent across feeds.
      - Older rows might have been saved before you improved extraction.

    Safety:
      - bounded by (days, limit, budget) because each successful attempt is an external request.
    """
    db.ensure_schema()
    try:
        days_i = max(1, int(days))
    except Exception:
        days_i = 365
    try:
        limit_i = max(1, min(int(limit), 2000))
    except Exception:
        limit_i = 200
    try:
        budget_i = max(0, min(int(budget), 500))
    except Exception:
        budget_i = 25

    updated = 0
    attempted = 0
    scanned = 0

    rows = db.list_articles_missing_image(days=days_i, limit=limit_i)
    scanned = len(rows)

    for r in rows:
        if budget_i <= 0:
            break
        aid = int(r.get("id") or 0)
        url = (r.get("url") or "").strip()
        if not aid or not url:
            continue

        attempted += 1
        best = _extract_best_image_from_url(url)
        if best:
            try:
                db.update_article_image_url(aid, best)
                updated += 1
            except Exception:
                logger.exception("backfill update_article_image_url failed")
        budget_i -= 1

    return {
        "scanned": scanned,
        "attempted": attempted,
        "updated": updated,
        "days": days_i,
        "limit": limit_i,
    }

    return None


# =========================================================
# RSS FETCH (robust to TLS/EOF + non-XML anti-bot)
# =========================================================


def _parse_rss_sources() -> dict[str, Any]:
    cfg = db.get_config()

    def _merge(defaults: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for country, by_lang in (defaults or {}).items():
            out[country] = {}
            for lang, by_topic in (by_lang or {}).items():
                out[country][lang] = {}
                for topic, items in (by_topic or {}).items():
                    out[country][lang][topic] = list(items or [])

        for country, by_lang in (overrides or {}).items():
            if not isinstance(by_lang, dict):
                continue
            out.setdefault(country, {})
            for lang, by_topic in (by_lang or {}).items():
                if not isinstance(by_topic, dict):
                    continue
                out[country].setdefault(lang, {})
                for topic, items in (by_topic or {}).items():
                    cur = list(out[country][lang].get(topic) or [])
                    add = list(items or [])
                    seen = {str(x.get("url") or "").strip() for x in cur if isinstance(x, dict)}
                    for it in add:
                        if not isinstance(it, dict):
                            continue
                        u = str(it.get("url") or "").strip()
                        if not u or u in seen:
                            continue
                        cur.append(it)
                        seen.add(u)
                    out[country][lang][topic] = cur
        return out

    sources = DEFAULT_RSS_SOURCES

    if cfg.rss_sources_json:
        try:
            custom = json.loads(cfg.rss_sources_json)
            if isinstance(custom, dict):
                sources = _merge(DEFAULT_RSS_SOURCES, custom)
        except Exception:
            logger.exception("Failed to parse RSS_SOURCES_JSON, using DEFAULT_RSS_SOURCES")

    if cfg.rss_local_sources_json:
        try:
            local_custom = json.loads(cfg.rss_local_sources_json)
            if isinstance(local_custom, dict):
                # Local sources are region-only. Never merge them into the world bucket.
                local_only = {
                    str(country).strip().lower(): by_lang
                    for country, by_lang in local_custom.items()
                    if str(country).strip().lower() != "world"
                }
                sources = _merge(sources, local_only)
        except Exception:
            logger.exception("Failed to parse RSS_LOCAL_SOURCES_JSON, ignoring local overrides")

    return sources


def _to_iso(dt_struct) -> str | None:
    try:
        if not dt_struct:
            return None
        dt = datetime.fromtimestamp(time.mktime(dt_struct), tz=timezone.utc)
        return dt.replace(microsecond=0).isoformat()
    except Exception:
        return None


def _looks_like_html(b: bytes) -> bool:
    head = (b or b"")[:400].lstrip().lower()
    return head.startswith(b"<html") or b"<!doctype" in head or b"<head" in head


def _sanitize_feed_bytes(data: bytes) -> bytes:
    """Remove illegal XML control bytes that make some feeds bozo for no good reason."""
    if not data:
        return b""
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        try:
            text = data.decode("latin-1", errors="replace")
        except Exception:
            return data
    text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", text)
    return text.encode("utf-8", errors="ignore")


def _parse_feed_with_requests(url: str, headers: dict[str, str]) -> tuple[feedparser.FeedParserDict, dict[str, Any]]:
    """Fetch RSS/Atom with requests first (more reliable than urllib in some TLS setups),
    then parse bytes via feedparser.

    Returns (parsed, fetch_meta) where fetch_meta includes status_code/content_type/is_html.
    """
    u = (url or '').strip()
    fetch_meta: dict[str, Any] = {"url": u, "status_code": None, "content_type": None, "is_html": False, "error": None}

    if not u:
        return feedparser.parse(u, request_headers=headers), fetch_meta

    # Build a small-retry requests session
    sess = None
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        sess = requests.Session()
        retry = Retry(
            total=3,
            connect=3,
            read=3,
            backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET",),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
        sess.mount('http://', adapter)
        sess.mount('https://', adapter)
    except Exception:
        sess = None

    h = dict(headers or {})
    h.setdefault('Accept-Language', 'en-US,en;q=0.9')
    # Some servers behave better without brotli; requests will transparently decode gzip/deflate.
    h.setdefault('Accept-Encoding', 'gzip, deflate')

    try:
        response = None
        if sess is not None:
            response = sess.get(u, headers=h, timeout=15, allow_redirects=True)
        else:
            response = requests.get(u, headers=h, timeout=15, allow_redirects=True)

        fetch_meta['status_code'] = getattr(response, 'status_code', None)
        fetch_meta['content_type'] = (getattr(response, 'headers', {}) or {}).get('content-type')
        data = getattr(response, 'content', b'') or b''

        # If server returns HTML (anti-bot / paywall), don't feed it into feedparser.
        if _looks_like_html(data):
            fetch_meta['is_html'] = True
            return feedparser.parse(b''), fetch_meta

        if data:
            parsed = feedparser.parse(data)
            if int(getattr(parsed, 'bozo', 0) or 0) and len(getattr(parsed, 'entries', []) or []) == 0:
                cleaned = _sanitize_feed_bytes(data)
                if cleaned and cleaned != data:
                    reparsed = feedparser.parse(cleaned)
                    if len(getattr(reparsed, 'entries', []) or []) > 0 or not int(getattr(reparsed, 'bozo', 0) or 0):
                        fetch_meta['sanitized'] = True
                        return reparsed, fetch_meta
            return parsed, fetch_meta
    except Exception as e:
        fetch_meta['error'] = str(e)
    finally:
        try:
            if sess is not None:
                sess.close()
        except Exception:
            pass

    # Last resort: let feedparser fetch it itself.
    return feedparser.parse(u, request_headers=headers), fetch_meta


def _fetch_rss_feed(feed: dict[str, str], per_feed: int = 80) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    url = (feed.get("url") or "").strip()
    name = (feed.get("name") or "unknown").strip()

    if not url:
        return [], {"name": name, "url": url, "ok": False, "reason": "empty_url"}

    headers = {
        "User-Agent": "NewsAggregator/1.0",
        "Accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
    }

    try:
        parsed, fetch_meta = _parse_feed_with_requests(url, headers)

        if fetch_meta.get('is_html'):
            return [], {
                'name': name,
                'url': url,
                'ok': False,
                'reason': 'html_response',
                **{k: v for k, v in fetch_meta.items() if v is not None},
            }

        bozo = int(getattr(parsed, "bozo", 0) or 0)
        bozo_exc = getattr(parsed, "bozo_exception", None) if bozo else None

        entries = list(getattr(parsed, "entries", []) or [])

        # If it's bozo but we still got entries, it's often just minor XML issues.
        # Don't spam warnings in that case.
        if bozo and len(entries) == 0:
            logger.warning("RSS bozo for %s: %s (ignored)", name, bozo_exc)

        # Filter to usable entries
        entries = [e for e in entries if e.get("title") and e.get("link")]

        out: list[dict[str, Any]] = []
        for entry in entries[:per_feed]:
            link = (getattr(entry, "link", None) or "").strip()
            if not link:
                continue

            title, desc, content = _safe_entry_text(entry)
            if not title:
                title = _guess_title_from_url(link) or _guess_title_from_desc(desc) or "Untitled"
            needs_fulltext = _should_fetch_full_article(name, desc, content)

            published_iso = _to_iso(getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None))
            img_url = _extract_image_url(entry)

            out.append(
                {
                    "title": title or "(no title)",
                    "description": desc,
                    "content": content,
                    "needs_fulltext": bool(needs_fulltext),
                    "image_url": img_url,
                    "url": link,
                    "url_hash": _url_hash(link),
                    "source_name": name,
                    "published_at": published_iso,
                    "raw": {"feed": {"name": name, "url": url}},
                }
            )

        meta = {
            'name': name,
            'url': url,
            'ok': True,
            'entries': len(out),
            'bozo': bozo,
            'bozo_exception': str(bozo_exc) if bozo_exc else None,
            **{k: v for k, v in fetch_meta.items() if v is not None},
        }
        return out, meta

    except Exception as e:
        logger.exception("RSS fetch failed: %s", url)
        return [], {"name": name, "url": url, "ok": False, "reason": str(e)}


def _iter_all_feeds(sources_cfg: dict[str, Any]) -> list[dict[str, str]]:
    feeds: list[dict[str, str]] = []

    for country, by_lang in (sources_cfg or {}).items():
        for language, by_topic in (by_lang or {}).items():
            for topic, items in (by_topic or {}).items():
                for f in items:
                    url = (f.get("url") or "").strip()
                    name = (f.get("name") or "unknown").strip()
                    if url:
                        feeds.append(
                            {
                                "url": url,
                                "name": name,
                                "country": country.lower(),
                                "language": language.lower(),
                                "topic": topic.lower(),
                            }
                        )

    seen: set[str] = set()
    uniq: list[dict[str, str]] = []
    for f in feeds:
        if f["url"] in seen:
            continue
        seen.add(f["url"])
        uniq.append(f)

    return uniq


def _select_feeds_for_cycle(feeds: list[dict[str, str]], max_feeds: int, rotation_seed: int = 0) -> list[dict[str, str]]:
    """Select feeds with a professional, feed-first strategy.

    Design goals:
    1) maximise outlet diversity in the main `world` feed, especially `world/general`;
    2) keep enough regional/topic coverage so non-world feeds do not go stale;
    3) rotate within every bucket from cycle to cycle so later publishers are surfaced too.

    Modern aggregators usually ingest every available upstream feed and only apply hard
    ranking limits later. This project still has a per-cycle network budget, so the next
    best strategy is to spend *most* of that budget on core world coverage and use the
    remaining capacity to keep regional buckets warm.
    """
    if max_feeds <= 0:
        return []
    if len(feeds) <= max_feeds:
        return list(feeds)

    country_priority = {"world": 0, "us": 1, "gb": 2, "de": 3, "fr": 4}
    topic_priority = {
        "general": 0,
        "politics": 1,
        "business": 2,
        "technology": 3,
        "science": 4,
        "health": 5,
        "sports": 6,
        "entertainment": 7,
    }

    def _bucket_sort_key(key: tuple[str, str]) -> tuple[int, int, str, str]:
        return (
            country_priority.get(key[0], 99),
            topic_priority.get(key[1], 99),
            key[0],
            key[1],
        )

    def _bucket_weight(key: tuple[str, str], size: int) -> float:
        country, topic = key
        weight = float(size)
        if country == "world" and topic == "general":
            weight *= 9.0
        elif country == "world" and topic in {"politics", "business", "technology"}:
            weight *= 4.5
        elif country == "world":
            weight *= 3.2
        elif topic == "general":
            weight *= 2.0
        elif topic in {"politics", "business", "technology"}:
            weight *= 1.35
        else:
            weight *= 1.0
        return weight

    grouped: dict[tuple[str, str], list[dict[str, str]]] = {}
    for f in feeds:
        key = ((f.get("country") or "world").lower(), (f.get("topic") or "general").lower())
        grouped.setdefault(key, []).append(f)

    non_empty_keys = [key for key, items in grouped.items() if items]
    if not non_empty_keys:
        return []
    non_empty_keys.sort(key=_bucket_sort_key)

    bucket_sizes = {key: len(grouped[key]) for key in non_empty_keys}
    allocations: dict[tuple[str, str], int] = {key: 0 for key in non_empty_keys}

    # Stage 1: guarantee strong core-world coverage first.
    world_general_key = ("world", "general")
    world_general_size = bucket_sizes.get(world_general_key, 0)
    if world_general_size > 0:
        if max_feeds >= 24:
            world_general_floor = max(12, int(round(max_feeds * 0.35)))
        elif max_feeds >= 12:
            world_general_floor = max(6, int(round(max_feeds * 0.25)))
        else:
            world_general_floor = max(1, int(round(max_feeds * 0.2)))
        allocations[world_general_key] = min(world_general_size, world_general_floor, max_feeds)

    used = sum(allocations.values())
    remaining = max(0, max_feeds - used)

    # Stage 2: keep every world bucket alive, then regional general buckets.
    preferred_keys: list[tuple[str, str]] = []
    preferred_keys.extend([key for key in non_empty_keys if key[0] == "world" and key != world_general_key])
    preferred_keys.extend([key for key in non_empty_keys if key[0] != "world" and key[1] == "general"])
    preferred_keys.extend([key for key in non_empty_keys if key not in preferred_keys and key != world_general_key])

    for key in preferred_keys:
        if remaining <= 0:
            break
        if allocations[key] >= bucket_sizes[key]:
            continue
        allocations[key] += 1
        remaining -= 1

    # Stage 3: spend the remaining budget by weighted residual capacity.
    if remaining > 0:
        fractional: list[tuple[float, tuple[str, str]]] = []
        weighted_residual_total = 0.0
        weighted_residuals: dict[tuple[str, str], float] = {}
        for key in non_empty_keys:
            residual = max(0, bucket_sizes[key] - allocations[key])
            if residual <= 0:
                continue
            weighted = _bucket_weight(key, residual)
            weighted_residuals[key] = weighted
            weighted_residual_total += weighted

        if weighted_residual_total > 0:
            for key, weighted in weighted_residuals.items():
                residual = max(0, bucket_sizes[key] - allocations[key])
                if residual <= 0:
                    continue
                exact = (remaining * weighted) / weighted_residual_total
                whole = min(residual, int(exact))
                allocations[key] += whole
                fractional.append((exact - whole, key))

            extra_left = max_feeds - sum(allocations.values())
            if extra_left > 0:
                fractional.sort(key=lambda item: (-item[0], *_bucket_sort_key(item[1])))
                for _frac, key in fractional:
                    if extra_left <= 0:
                        break
                    if allocations[key] >= bucket_sizes[key]:
                        continue
                    allocations[key] += 1
                    extra_left -= 1

    rotated_trimmed: dict[tuple[str, str], list[dict[str, str]]] = {}
    for idx, key in enumerate(non_empty_keys):
        bucket = list(grouped.get(key) or [])
        if not bucket:
            continue
        rot = 0
        if len(bucket) > 1:
            rot = (int(rotation_seed or 0) + (idx * 3)) % len(bucket)
        rotated = bucket[rot:] + bucket[:rot]
        rotated_trimmed[key] = rotated[: max(0, allocations.get(key, 0))]

    selected: list[dict[str, str]] = []
    while len(selected) < max_feeds:
        made_progress = False
        for key in non_empty_keys:
            bucket = rotated_trimmed.get(key) or []
            if not bucket:
                continue
            selected.append(bucket.pop(0))
            made_progress = True
            if len(selected) >= max_feeds:
                break
        if not made_progress:
            break

    selection_counts = {
        f"{country}/{topic}": allocations.get((country, topic), 0)
        for country, topic in non_empty_keys
        if allocations.get((country, topic), 0) > 0
    }
    logger.info(
        "RSS selection summary: max_feeds=%s total_feeds=%s selected=%s buckets=%s",
        max_feeds,
        len(feeds),
        len(selected[:max_feeds]),
        selection_counts,
    )

    return selected[:max_feeds]


def _scoped_cluster_key(country: str, base_key: str) -> str:
    scope = (country or "world").strip().lower() or "world"
    return f"{scope}|{base_key}"


# =========================================================
# MAIN INGEST CYCLE
# =========================================================


def run_ingest_cycle() -> dict[str, Any]:
    db.ensure_schema()
    cfg = db.get_config()

    run_id = db.start_ingest_run()
    stats: dict[str, Any] = {
        "feeds_total": 0,
        "feeds_used": 0,
        "feeds_meta": [],
        "articles_seen": 0,
        "articles_inserted": 0,
        "clusters_touched": 0,
        "scores_updated": 0,
        "summaries_attempted": 0,
        "summaries_success": 0,
        "errors": 0,
        "started_at": _utc_now_iso(),
    }

    try:
        sources_cfg = _parse_rss_sources()
        feeds = _iter_all_feeds(sources_cfg)

        stats["feeds_total"] = len(feeds)
        max_feeds = max(10, int(cfg.max_external_requests_per_cycle))
        feeds = _select_feeds_for_cycle(feeds, max_feeds, rotation_seed=run_id)
        stats["feeds_used"] = len(feeds)

        all_articles: list[dict[str, Any]] = []

        for f in feeds:
            entries, meta = _fetch_rss_feed(f, per_feed=80)
            meta.update({"country": f["country"], "language": f["language"], "topic": f["topic"]})
            stats["feeds_meta"].append(meta)

            for a in entries:
                a["country"] = f["country"]
                a["language"] = f["language"]
                a["topic"] = f["topic"]
            all_articles.extend(entries)

        stats["articles_seen"] = len(all_articles)

        inserted_article_ids: list[int] = []
        for a in all_articles:
            try:
                aid = db.insert_article_if_new(a)
                if aid is not None:
                    inserted_article_ids.append(aid)
                    stats["articles_inserted"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("insert_article_if_new failed")

        # Image upgrade (limited, only for new articles)
        # - If RSS image is missing OR looks like a thumbnail, try the article page.
        try:
            og_budget = 25
            for aid in inserted_article_ids:
                if og_budget <= 0:
                    break
                art = db.get_article_by_id(aid)
                if not art:
                    continue
                cur_img = (art.get("image_url") or "").strip()
                if cur_img and not _is_probably_low_res(cur_img):
                    continue
                url = (art.get("url") or "").strip()
                if not url:
                    continue
                best = _extract_best_image_from_url(url)
                if best and best != cur_img:
                    db.update_article_image_url(aid, best)
                og_budget -= 1
        except Exception:
            stats["errors"] += 1
            logger.exception("image upgrade failed")

        # Backfill missing images for older rows (bounded)
        # This helps fix clusters/cards that were generated before improving image extraction.
        try:
            stats["images_backfilled"] = backfill_article_images(days=365, limit=120, budget=12)
        except Exception:
            stats["errors"] += 1
            logger.exception("image backfill failed")

        touched_clusters: set[int] = set()

        inserted_by_scope_lang: dict[tuple[str, str], list[int]] = {}
        for aid in inserted_article_ids:
            art = db.get_article_by_id(aid)
            lang = (art.get("language") or "en").lower()
            country = (art.get("country") or "world").lower()
            inserted_by_scope_lang.setdefault((country, lang), []).append(aid)

        for (scope_country, lang), aids in inserted_by_scope_lang.items():
            candidates_db = db.list_recent_clusters(language=lang, country=scope_country, limit=900)
            candidates_meta: list[dict[str, Any]] = []
            for c in candidates_db:
                cid = int(c["id"])
                c_title = (c.get("title") or "").strip()
                recent_titles = db.get_cluster_article_titles(cid, limit=8)
                title_text = " ".join([c_title] + recent_titles).strip()
                # Use title-focused text for matching; descriptions are noisier and can pull unrelated stories in.
                ctext = title_text
                latest = db.get_cluster_latest_published_at(cid)
                c_topic = (c.get("topic") or "general").strip().lower()
                c_country = (c.get("country") or "world").strip().lower() or "world"
                c_ents = _extract_entities(title_text)
                c_terms = _title_signature_terms(title_text)
                candidates_meta.append(
                    {
                        "cid": cid,
                        "text": ctext,
                        "title_text": title_text,
                        "topic": c_topic,
                        "country": c_country,
                        "latest_published_at": latest,
                        "entities": c_ents,
                        "title_terms": c_terms,
                        "is_liveblog": _is_liveblog(None, c_title),
                    }
                )

            for aid in aids:
                art = db.get_article_by_id(aid)
                title = (art.get("title") or "").strip()
                desc = (art.get("description") or "").strip()
                article_text = f"{title} {desc}".strip()
                a_title_terms = _title_signature_terms(title)

                is_liveblog = _is_liveblog(art.get("url"), title)

                if is_liveblog:
                    cluster_key = _scoped_cluster_key(scope_country, _liveblog_cluster_key(lang, (art.get("url") or "")))
                else:
                    norm_title = normalize_title_for_key(title, lang)
                    if not norm_title:
                        # Broken feeds sometimes omit <title>. Never allow an empty cluster key.
                        norm_title = normalize_title_for_key(desc, lang)
                    if not norm_title:
                        norm_title = normalize_title_for_key(_guess_title_from_url(art.get("url") or ""), lang)

                    # If the title is still missing OR looks low-signal, fall back to a per-URL key.
                    # This prevents unrelated stories from being merged because of generic gallery/boilerplate titles.
                    if (not norm_title) or _is_low_signal_norm_title(norm_title, title):
                        u = (art.get("url") or "").split("#", 1)[0].split("?", 1)[0]
                        norm_title = "url:" + hashlib.sha1(u.encode("utf-8", errors="ignore")).hexdigest()[:16]

                    cluster_key = _scoped_cluster_key(scope_country, canonical_cluster_key(lang, norm_title))

                existing = db.connect().execute(
                    "SELECT id FROM clusters WHERE cluster_key=?",
                    (cluster_key,),
                ).fetchone()

                if existing:
                    cluster_id = int(existing["id"])
                else:
                    a_topic = (art.get("topic") or "general").strip().lower()
                    a_dt = _parse_iso_dt(art.get("published_at"))
                    a_ents = _extract_entities(f"{title} {desc}")

                    min_j = float(os.getenv("CLUSTER_MIN_ENTITY_JACCARD", "0.08"))
                    hours = int(os.getenv("CLUSTER_TIME_WINDOW_HOURS", "72"))

                    candidates: list[tuple[int, str]] = []
                    for c in candidates_meta:
                        c_topic = (c.get("topic") or "general").strip().lower()

                        if bool(c.get("is_liveblog")) != bool(is_liveblog):
                            continue
                        if (c.get("country") or "world") != scope_country:
                            continue
                        if c_topic != a_topic and "general" not in (c_topic, a_topic):
                            continue

                        c_dt = _parse_iso_dt(c.get("latest_published_at"))
                        if a_dt and c_dt and abs(a_dt - c_dt) > timedelta(hours=hours):
                            continue

                        c_ents = c.get("entities") or set()
                        if len(a_ents) >= 4 and len(c_ents) >= 4:
                            if _jaccard(a_ents, c_ents) < min_j:
                                continue

                        if _should_skip_candidate_by_title(
                            article_title=title,
                            article_desc=desc,
                            article_terms=a_title_terms,
                            article_entities=a_ents,
                            candidate_title_text=str(c.get("title_text") or c.get("text") or ""),
                            candidate_terms=set(c.get("title_terms") or set()),
                            candidate_entities=c_ents,
                        ):
                            continue

                        candidates.append((int(c["cid"]), str(c["text"])))

                    m = match_cluster(
                        article_text=article_text,
                        candidates=candidates,
                        similarity_threshold=SIMILARITY_THRESHOLD,
                    )
                    if m.cluster_id is not None:
                        cluster_id = int(m.cluster_id)
                    else:
                        cluster_id = db.upsert_cluster(
                            cluster_key=cluster_key,
                            title=title or "Untitled event",
                            topic=(art.get("topic") or "general").lower(),
                            country=(art.get("country") or "world").lower(),
                            language=lang,
                        )
                        candidates_meta.append(
                            {
                                "cid": cluster_id,
                                "text": f"{title} {desc}".strip(),
                                "topic": a_topic,
                                "latest_published_at": art.get("published_at"),
                                "entities": a_ents,
                                "is_liveblog": bool(is_liveblog),
                            }
                        )

                linked = db.link_cluster_article(cluster_id, aid)
                if linked:
                    touched_clusters.add(cluster_id)

        stats["clusters_touched"] = len(touched_clusters)

        # Score clusters
        for cid in touched_clusters:
            try:
                meta = db.get_cluster_meta(cid)
                cluster_title = (meta.get("title") or "Event").strip()
                sources = db.get_cluster_sources(cid)
                score, details = compute_credibility(cluster_title=cluster_title, sources=sources)
                db.upsert_score(cluster_id=cid, credibility_score=score, details=details)

                # Record server-side trust score history point (for Tracking chart)
                try:
                    uniq_sources = {
                        (s.get("source_name") or "").strip().lower()
                        for s in (sources or [])
                        if (s.get("source_name") or "").strip()
                    }
                    sources_count = len(uniq_sources)
                    db.record_trust_history_if_changed(cluster_id=int(cid), score=int(score), sources_count=int(sources_count))
                except Exception:
                    # History is best-effort; never fail ingest because of it.
                    pass

                stats["scores_updated"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("scoring failed for cluster_id=%s", cid)

        def uniq_sources_count(cid: int) -> int:
            return len({(s.get("source_name") or "").strip().lower() for s in db.get_cluster_sources(cid)})

        top_n = 20
        touched_sorted = sorted(list(touched_clusters), key=lambda x: uniq_sources_count(x), reverse=True)
        touched_sorted = [cid for cid in touched_sorted if uniq_sources_count(cid) >= 2][:top_n]

        # Summaries only for top clusters
        summary_model = os.getenv("OPENAI_SUMMARY_MODEL", "").strip() or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
        try:
            summary_min_interval = int(os.getenv("SUMMARY_REGEN_MIN_INTERVAL_SECONDS", str(30 * 60)))
        except Exception:
            summary_min_interval = 6 * 60 * 60

        for cid in touched_sorted:
            try:
                meta = db.get_cluster_meta(cid)
                title = (meta.get("title") or "Event").strip()
                sources = db.get_cluster_sources(cid)

                should_run, reason, source_fp, source_count = _should_refresh_summary(
                    cluster_id=int(cid),
                    sources=sources,
                    min_interval_seconds=summary_min_interval,
                )
                if not should_run:
                    stats.setdefault("summaries_skipped", 0)
                    stats["summaries_skipped"] += 1
                    logger.info("summary skipped for cluster_id=%s reason=%s", cid, reason)
                    continue

                stats["summaries_attempted"] += 1
                brief, summary_json, status, raw_text = summarize_cluster(
                    cluster_title=title,
                    sources=sources,
                    model=summary_model,
                )
                db.upsert_summary(
                    cluster_id=cid,
                    summary_text=brief,
                    summary_json=summary_json,
                    raw_text=raw_text,
                    model=summary_model,
                    status=status,
                    source_fingerprint=source_fp,
                    source_count=source_count,
                )
                if status == "success":
                    stats["summaries_success"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("summary failed for cluster_id=%s", cid)


        # Prefetch Video Report for top clusters (warms DB cache; reduces YouTube calls on user open)
        try:
            max_prefetch = int(os.getenv("YT_PREFETCH_TOP_N", "6"))
        except Exception:
            max_prefetch = 6

        if max_prefetch > 0:
            try:
                pf = prefetch_video_reports_for_clusters(
                    cluster_ids=[int(x) for x in touched_sorted],
                    lang_fallback="en",
                    max_prefetch=max_prefetch,
                    max_results=5,
                )
                stats["video_prefetch"] = pf
            except Exception:
                stats["errors"] += 1
                logger.exception("video prefetch failed")

        try:
            cleanup = db.cleanup_old_data(keep_days=30)
            stats["cleanup"] = cleanup
        except Exception:
            stats["errors"] += 1
            logger.exception("cleanup failed")

        stats.update(get_llm_budget_stats())
        stats["ai_usage_24h"] = db.get_recent_ai_usage_summary(hours=24)
        stats["finished_at"] = _utc_now_iso()
        db.finish_ingest_run(run_id, "success", stats)
        return stats

    except Exception:
        stats["errors"] += 1
        stats.update(get_llm_budget_stats())
        stats["finished_at"] = _utc_now_iso()
        logger.exception("Ingest cycle failed")
        db.finish_ingest_run(run_id, "failed", stats)
        return stats
