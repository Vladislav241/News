# src/app/ingest.py
from __future__ import annotations

import os
import hashlib
import json
import logging
import time


# --- clustering gates helpers (cheap, offline) ---
import re as _re
from datetime import datetime, timezone, timedelta

_CAP_SEQ_RE = _re.compile(r"\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}|[A-Z]{2,}(?:\s+[A-Z]{2,}){0,2})\b")
_NOISE = {"the","and","for","with","from","says","said","new","news","live","update","breaking"}

def _extract_entities(text: str) -> set[str]:
    if not text:
        return set()
    ents: set[str] = set()
    for m in _CAP_SEQ_RE.finditer(text):
        chunk = m.group(0).strip()
        parts = [w.strip('.') for w in chunk.split()]
        if len(parts)==1 and len(parts[0]) < 4:
            continue
        norm = " ".join(parts).lower()
        if norm in _NOISE:
            continue
        ents.add(norm)
        for w in parts:
            lw = w.lower()
            if lw not in _NOISE and len(lw) >= 3:
                ents.add(lw)
    # limit size
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
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup


# =========================================================
# RSS TEXT SANITIZATION
# Many feeds (e.g. The Guardian) embed "Recommended/What to read next"
# blocks and extra link lists into the RSS <description>. Those fragments
# pollute clustering and cause unrelated stories to be merged.
# We keep only the first meaningful paragraph and cut off common promo blocks.
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
    """Heuristic: detect sidebar/recommended headline lines."""
    if not line:
        return False
    s = line.strip()
    if len(s) < 25 or len(s) > 140:
        return False
    # Too many Title Case words or ALLCAPS chunks
    words = [w for w in _re.split(r"\s+", s) if w]
    if len(words) < 4:
        return False
    caps = sum(1 for w in words if (w[:1].isupper() and w[1:].islower()))
    allcaps = sum(1 for w in words if w.isupper() and len(w) >= 3)
    # headline punctuation patterns
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
            # remove noisy elements if present
            for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                tag.decompose()

            # Prefer first paragraph as a compact summary
            p = soup.find("p")
            if p:
                t = p.get_text(" ", strip=True)
            else:
                t = soup.get_text(" ", strip=True)
        except Exception:
            # fall back to raw
            t = BeautifulSoup(t, "html.parser").get_text(" ", strip=True)

    # Hard cut on common promo markers
    low = t.lower()
    cut_at = None
    for m in _CUT_MARKERS:
        idx = low.find(m)
        if idx != -1:
            cut_at = idx if cut_at is None else min(cut_at, idx)
    if cut_at is not None and cut_at > 0:
        t = t[:cut_at].strip()

    # Drop bullet-heavy tails (often link lists)
    lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
    if len(lines) > 1:
        # If many lines start with bullets, keep only the first line.
        bulletish = sum(1 for ln in lines[1:] if ln.startswith(("•", "-", "*")))
        if bulletish >= 1:
            t = lines[0]

    # Limit length so clustering isn't dominated by boilerplate
    if len(t) > 450:
        t = t[:450].rsplit(" ", 1)[0].strip() + "…"
    return t


# =========================================================
# FULL ARTICLE EXTRACTION (IRONCLAD CLUSTER INPUT)
# Many sites contaminate RSS descriptions with "Most popular/Related/Recommended"
# blocks. For clustering we want only the main article body.
# We therefore (selectively) fetch the article HTML and extract an "article-only"
# text using multiple strategies: JSON-LD articleBody, <article>/<main> tags,
# and a scored best-text container fallback.
# =========================================================

_ARTICLE_CACHE: dict[str, tuple[float, str]] = {}
_ARTICLE_CACHE_TTL_SEC = 60 * 30  # 30 minutes

def _now_ts() -> float:
    try:
        return time.time()
    except Exception:
        return 0.0

def _looks_contaminated(text: str) -> bool:
    if not text:
        return True
    low = text.lower()
    # obvious boilerplate / sidebar markers
    if any(m in low for m in _CUT_MARKERS):
        return True
    if any(m in low for m in ("most popular", "popular", "trending", "you might also", "more stories", "more from", "advertisement")):
        return True
    # headline list patterns (often "Related: X / Y / Z")
    # many title-like chunks separated by newlines or bullets
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
    # Always fetch for sources known to pollute RSS descriptions
    sn = (source_name or "").lower()
    if sn in {"the hill", "the guardian world", "the guardian"}:
        return True
    t = (desc or "") + " " + (content or "")
    if _looks_contaminated(t):
        return True
    # too short -> RSS may be useless
    if len((desc or "").strip()) < 120 and len((content or "").strip()) < 200:
        return True
    return False

def _sentences(text: str) -> list[str]:
    t = (text or "").strip()
    if not t:
        return []
    # simple sentence splitter
    parts = _re.split(r"(?<=[.!?])\s+", t)
    out = []
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
        # some pages have multiple JSON blobs
        blobs = []
        try:
            blobs = [json.loads(raw)]
        except Exception:
            # try to recover multiple objects
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
            if any(k in typ_s for k in ("newsarticle","article","report")):
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
    # Try <article> first
    candidates = []
    for tag_name in ("article", "main"):
        for node in soup.find_all(tag_name):
            txt = node.get_text(" ", strip=True)
            if len(txt) >= 400:
                candidates.append((len(txt), node))
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1].get_text(" ", strip=True)

    # Fallback: score div/section containers
    best = ("", -1e18)
    for node in soup.find_all(["div","section"]):
        txt = node.get_text(" ", strip=True)
        tl = len(txt)
        if tl < 500:
            continue
        ltd = _link_text_len(node)
        # penalize link-heavy blocks (sidebars)
        score = tl - 4 * ltd
        # penalize very short average word (menus)
        words = txt.split()
        if words:
            avg = sum(len(w) for w in words) / max(1, len(words))
            if avg < 4.0:
                score -= 400
        # penalize too many list items
        li = len(node.find_all("li"))
        if li >= 8:
            score -= 300
        if score > best[1]:
            best = (txt, score)
    return best[0] if best[0] else soup.get_text(" ", strip=True)

def _fetch_article_text(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""
    # cache
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
        # remove noisy tags
        for tag in soup(["script","style","noscript","svg","canvas","form","nav","footer","header","aside"]):
            tag.decompose()

        # JSON-LD articleBody is the cleanest when present
        jsonld = _extract_from_jsonld(soup)
        if jsonld:
            text = jsonld
        else:
            # og:description is decent backup, but can be short
            ogd = soup.find("meta", property="og:description")
            if ogd and (ogd.get("content") or "").strip():
                og_text = (ogd.get("content") or "").strip()
            else:
                og_text = ""
            main_text = _best_container_text(soup)
            # prefer main_text when it's meaningful; otherwise use og_text
            text = main_text if len(main_text) >= 400 else (og_text or main_text)

        # Final cleanup: cut off promo/related blocks again
        text = _clean_rss_html(text)

        # guardrail: keep at most ~1800 chars for clustering (prevents boilerplate domination)
        if len(text) > 1800:
            text = text[:1800].rsplit(" ", 1)[0].strip() + "…"

        _ARTICLE_CACHE[h] = (ts, text)
        return text
    except Exception:
        return ""


# =========================================================
# BACKGROUND FULLTEXT JOBS (NON-BLOCKING)
# We never block the ingest cycle on HTML fetching.
# These jobs run in a separate loop (see main.py) and update articles in-place.
# =========================================================

def _backoff_seconds(attempts: int) -> int:
    # 1st fail: 30s, 2nd: 2m, 3rd: 5m, then cap at 20m
    a = max(1, int(attempts))
    if a == 1:
        return 30
    if a == 2:
        return 120
    if a == 3:
        return 300
    return min(1200, 300 * a)


def process_fulltext_queue_once(max_jobs: int = 8, max_workers: int = 6) -> dict[str, Any]:
    """Process a small batch of fulltext jobs.

    Returns a tiny stats dict for logging.
    """
    db.ensure_schema()
    max_jobs = int(max(1, min(50, max_jobs)))
    max_workers = int(max(1, min(16, max_workers)))

    pending = db.list_fulltext_pending(limit=max_jobs)
    if not pending:
        return {"picked": 0, "done": 0, "failed": 0}

    # Claim first so concurrent workers don't duplicate work.
    claimed: list[dict[str, Any]] = []
    for row in pending:
        aid = int(row.get('id') or 0)
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
        aid = int(item.get('id') or 0)
        url = (item.get('url') or '').strip()
        if not url:
            return aid, '', '', 'empty_url'
        text = _fetch_article_text(url)
        if not text or len(text) < 200:
            return aid, '', '', 'no_text'
        ss = _sentences(text)
        desc = " ".join(ss[:2]).strip() if ss else ''
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
                    # attempts are tracked in DB; use current value to compute backoff
                    art = db.get_article_by_id(int(aid))
                    attempts = int(art.get('fulltext_attempts') or 0) + 1
                    db.mark_fulltext_failed(aid, err, _backoff_seconds(attempts))
                    failed += 1
            except Exception as e:
                failed += 1

    return {"picked": len(claimed), "done": done, "failed": failed}


from .ai import summarize_cluster
from .clustering import canonical_cluster_key, match_cluster, normalize_title_for_key
from .db import db
from .scoring import compute_credibility

logger = logging.getLogger("news.ingest")
logger.setLevel(logging.INFO)

DEFAULT_RSS_SOURCES: dict[str, Any] = {
    "world": {
        "en": {
            "general": [
                {"name": "AP Top News", "url": "https://apnews.com/hub/ap-top-news/rss"},
                {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
                {"name": "The Guardian World", "url": "https://www.theguardian.com/world/rss"},
                {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
                {"name": "DW", "url": "https://rss.dw.com/rdf/rss-en-all"},
                {"name": "Reuters World (Unofficial Mirror)", "url": "https://www.reutersagency.com/feed/?best-sectors=world&post_type=best"},
                {"name": "NYT World", "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"},
                {"name": "The Hill", "url": "https://thehill.com/feed/"},
                {"name": "Axios", "url": "https://api.axios.com/feed/"},
            ],
        }
    }
}

SIMILARITY_THRESHOLD = 0.33


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()




# --- liveblog / live updates detection ---
# Liveblog pages often contain many unrelated topics inside one "article" (especially Guardian live pages).
# If we cluster them with normal articles, they can "poison" clusters and pull in unrelated stories.
_LIVEBLOG_URL_RE = _re.compile(r"(/live/|/liveblog/|/live-updates/|/live-updates$)", _re.IGNORECASE)
_LIVEBLOG_TITLE_RE = _re.compile(r"\b(live updates?|liveblog|live blog|latest news updates)\b", _re.IGNORECASE)

def _is_liveblog(url: str | None, title: str | None) -> bool:
    u = (url or "").strip().lower()
    t = (title or "").strip().lower()
    if not u and not t:
        return False
    if u:
        # strip query/fragments
        try:
            u = u.split("#", 1)[0]
            u = u.split("?", 1)[0]
        except Exception:
            pass
        if _LIVEBLOG_URL_RE.search(u):
            return True
        # Guardian live pages are the most problematic
        if "theguardian.com" in u and "/live/" in u:
            return True
    if t and _LIVEBLOG_TITLE_RE.search(t):
        return True
    # common feed prefixes
    if t.startswith("live:") or t.startswith("live -") or t.startswith("live —") or t.startswith("live updates:"):
        return True
    return False

def _liveblog_cluster_key(language: str, url: str) -> str:
    # Use canonical URL (without query/fragment) to ensure a single liveblog gets a single cluster,
    # but never collides with normal cluster keys.
    u = (url or "").strip()
    try:
        u = u.split("#", 1)[0]
        u = u.split("?", 1)[0]
    except Exception:
        pass
    base = f"live::{(language or 'en').lower()}::{u.lower()}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()
def _parse_rss_sources() -> dict[str, Any]:
    cfg = db.get_config()
    if cfg.rss_sources_json:
        try:
            return json.loads(cfg.rss_sources_json)
        except Exception:
            logger.exception("Failed to parse RSS_SOURCES_JSON, using DEFAULT_RSS_SOURCES")
    return DEFAULT_RSS_SOURCES


def _to_iso(dt_struct) -> str | None:
    try:
        if not dt_struct:
            return None
        dt = datetime.fromtimestamp(time.mktime(dt_struct), tz=timezone.utc)
        return dt.replace(microsecond=0).isoformat()
    except Exception:
        return None


def _safe_entry_text(entry: Any) -> tuple[str, str, str]:
    title = (getattr(entry, "title", None) or "").strip()
    desc = (getattr(entry, "summary", None) or getattr(entry, "description", None) or "").strip()
    content = ""

    try:
        if getattr(entry, "content", None):
            content = (entry.content[0].value or "").strip()
    except Exception:
        content = ""

    # Clean RSS HTML/link blocks that break clustering
    return title, _clean_rss_html(desc), _clean_rss_html(content)


# =========================================================
# IMAGE EXTRACTION (FIXED, SAFE, NON-DESTRUCTIVE)
# =========================================================

def _extract_og_image_from_url(url: str) -> str | None:
    try:
        import requests
        from bs4 import BeautifulSoup

        resp = requests.get(
            url,
            timeout=6,
            headers={"User-Agent": "Mozilla/5.0 (NewsAggregator)"},
        )
        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        og = soup.find("meta", property="og:image")
        if not og:
            return None

        content = (og.get("content") or "").strip()
        return content or None
    except Exception:
        return None

    try:
        resp = requests.get(
            url,
            timeout=6,
            headers={"User-Agent": "Mozilla/5.0 (NewsAggregator)"},
        )
        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "html.parser")
        og = soup.find("meta", property="og:image")

        if og:
            content = (og.get("content") or "").strip()
            if content:
                return content
    except Exception:
        return None

    return None


def _extract_image_url(entry: Any) -> str | None:
    """
    Достаём картинку ТОЛЬКО из RSS (быстро).
    og:image НЕ трогаем тут, чтобы ingest не висел.
    """
    try:
        # enclosure
        if getattr(entry, "enclosures", None):
            for e in entry.enclosures:
                href = (getattr(e, "href", None) or "").strip()
                typ = (getattr(e, "type", None) or "").strip().lower()
                if href and (typ.startswith("image") or href.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))):
                    return href

        # media:content
        media_content = getattr(entry, "media_content", None)
        if media_content:
            for m in media_content:
                url = (m.get("url") or "").strip()
                if url:
                    return url

        # media:thumbnail
        media_thumb = getattr(entry, "media_thumbnail", None)
        if media_thumb:
            for m in media_thumb:
                url = (m.get("url") or "").strip()
                if url:
                    return url

        # links list (иногда картинки тут)
        links = getattr(entry, "links", None) or []
        for l in links:
            href = (l.get("href") or "").strip()
            typ = (l.get("type") or "").strip().lower()
            if not href:
                continue
            looks_like_img = href.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".webp"))
            if looks_like_img and (typ.startswith("image") or typ == ""):
                return href

    except Exception:
        return None

    return None

    """
    Стратегия:
    1) og:image со страницы статьи (главный и самый точный источник)
    2) RSS media / enclosure
    3) None (лучше без картинки, чем мусор)
    """
    try:
        link = (getattr(entry, "link", None) or "").strip()
        if link:
            og_img = _extract_og_image_from_url(link)
            if og_img:
                return og_img
    except Exception:
        pass

    # ---- RSS fallback ----
    try:
        if getattr(entry, "enclosures", None):
            for e in entry.enclosures:
                href = (getattr(e, "href", None) or "").strip()
                typ = (getattr(e, "type", None) or "").strip().lower()
                if href and (typ.startswith("image") or href.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))):
                    return href

        media_content = getattr(entry, "media_content", None)
        if media_content:
            for m in media_content:
                url = (m.get("url") or "").strip()
                if url:
                    return url

        media_thumb = getattr(entry, "media_thumbnail", None)
        if media_thumb:
            for m in media_thumb:
                url = (m.get("url") or "").strip()
                if url:
                    return url
    except Exception:
        return None

    return None


def _url_hash(url: str) -> str:
    u = (url or "").strip().split("#")[0]
    return hashlib.sha1(u.encode("utf-8")).hexdigest()

def _parse_feed_with_requests(url: str, headers: dict[str, str]) -> Any:
   # 1) СНАЧАЛА качаем сами (requests гораздо стабильнее)
    try:
        r = requests.get(url, headers=headers, timeout=12, allow_redirects=True)
        r.raise_for_status()
        parsed = feedparser.parse(r.content)

        # если feedparser всё равно ругается bozo, вернём как есть (часто entries есть)
        return parsed
    except Exception:
        pass

    # 2) Фолбек: старый способ (на случай если requests не смог)
    return feedparser.parse(url, request_headers=headers)


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
        parsed = _parse_feed_with_requests(url, headers)


        bozo = int(getattr(parsed, "bozo", 0) or 0)
        bozo_exc = getattr(parsed, "bozo_exception", None) if bozo else None
        if bozo:
            logger.warning("RSS bozo for %s: %s (ignored)", name, bozo_exc)

        entries = list(getattr(parsed, "entries", []) or [])
        logger.info("RSS %s: bozo=%s entries=%d", name, bozo, len(entries))

        entries = [e for e in entries if e.get("title") and e.get("link")]

        out: list[dict[str, Any]] = []

        for entry in entries[:per_feed]:
            link = (getattr(entry, "link", None) or "").strip()
            if not link:
                continue

            title, desc, content = _safe_entry_text(entry)
            needs_fulltext = _should_fetch_full_article(name, desc, content)

            published_iso = _to_iso(
                getattr(entry, "published_parsed", None)
                or getattr(entry, "updated_parsed", None)
            )

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
            "name": name,
            "url": url,
            "ok": True,
            "entries": len(out),
            "bozo": bozo,
            "bozo_exception": str(bozo_exc) if bozo_exc else None,
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

    seen = set()
    uniq: list[dict[str, str]] = []
    for f in feeds:
        if f["url"] in seen:
            continue
        seen.add(f["url"])
        uniq.append(f)

    return uniq


# =========================================================
# MAIN INGEST CYCLE (НЕ ТРОНУТ)
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
        feeds = feeds[:max_feeds]
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

        # =========================================================
        # ✅ NEW: OG IMAGE ENRICHMENT (LIMITED, ONLY FOR NEW ARTICLES)
        # =========================================================
        try:
            MAX_OG_IMAGE_FETCHES_PER_CYCLE = 25
            og_budget = MAX_OG_IMAGE_FETCHES_PER_CYCLE

            for aid in inserted_article_ids:
                if og_budget <= 0:
                    break

                art = db.get_article_by_id(aid)
                if not art:
                    continue

                # если уже есть картинка из RSS — не трогаем
                if (art.get("image_url") or "").strip():
                    continue

                url = (art.get("url") or "").strip()
                if not url:
                    continue

                og_img = _extract_og_image_from_url(url)
                if og_img:
                    db.update_article_image_url(aid, og_img)

                og_budget -= 1

        except Exception:
            stats["errors"] += 1
            logger.exception("og:image enrichment failed")

        touched_clusters: set[int] = set()

        inserted_by_lang: dict[str, list[int]] = {}
        for aid in inserted_article_ids:
            art = db.get_article_by_id(aid)
            lang = (art.get("language") or "en").lower()
            inserted_by_lang.setdefault(lang, []).append(aid)

        for lang, aids in inserted_by_lang.items():
            candidates_db = db.list_recent_clusters(language=lang, limit=900)
            # Precompute candidate meta once per language for better matching quality.
            candidates_meta: list[dict] = []
            for c in candidates_db:
                cid = int(c["id"])
                txts = db.get_cluster_article_texts(cid, limit=10)
                ctext = " ".join([(c.get("title") or "")] + txts).strip()
                latest = db.get_cluster_latest_published_at(cid)
                c_topic = (c.get("topic") or "general").strip().lower()
                c_ents = _extract_entities(ctext)
                candidates_meta.append({
                    "cid": cid,
                    "text": ctext,
                    "topic": c_topic,
                    "latest_published_at": latest,
                    "entities": c_ents,
                    "is_liveblog": _is_liveblog(None, (c.get("title") or "")),
                })

            for aid in aids:
                art = db.get_article_by_id(aid)
                title = (art.get("title") or "").strip()
                desc = (art.get("description") or "").strip()
                # Do not use full `content` for clustering.
                # Title + cleaned description is the most stable signal and prevents
                # sidebar/recommended pollution from leaking into cluster similarity.
                article_text = f"{title} {desc}".strip()

                # Liveblogs are multi-topic by nature; never allow them to cluster with normal articles.
                is_liveblog = _is_liveblog(art.get("url"), title)

                if is_liveblog:
                    cluster_key = _liveblog_cluster_key(lang, (art.get("url") or ""))
                    norm_title = normalize_title_for_key(title, lang)  # for display only
                else:
                    norm_title = normalize_title_for_key(title, lang)
                    cluster_key = canonical_cluster_key(lang, norm_title or title[:120])

                existing = db.connect().execute(
                    "SELECT id FROM clusters WHERE cluster_key=?",
                    (cluster_key,),
                ).fetchone()

                if existing:
                    cluster_id = int(existing["id"])
                else:
                    # --- gate before clustering ---
                    a_topic = (art.get('topic') or 'general').strip().lower()
                    a_dt = _parse_iso_dt(art.get('published_at'))
                    a_ents = _extract_entities(f"{title} {desc}")

                    min_j = float(os.getenv('CLUSTER_MIN_ENTITY_JACCARD', '0.08'))
                    hours = int(os.getenv('CLUSTER_TIME_WINDOW_HOURS', '72'))

                    candidates: list[tuple[int, str]] = []
                    for c in candidates_meta:
                        c_topic = (c.get('topic') or 'general').strip().lower()

                        # liveblog isolation: never match liveblog clusters with non-live articles and vice versa
                        if bool(c.get('is_liveblog')) != bool(is_liveblog):
                            continue
                        # topic/section gate
                        if c_topic != a_topic and 'general' not in (c_topic, a_topic):
                            continue

                        # time window gate
                        c_dt = _parse_iso_dt(c.get('latest_published_at'))
                        if a_dt and c_dt and abs(a_dt - c_dt) > timedelta(hours=hours):
                            continue

                        # entity overlap gate (soft)
                        c_ents = c.get('entities') or set()
                        if len(a_ents) >= 4 and len(c_ents) >= 4:
                            if _jaccard(a_ents, c_ents) < min_j:
                                continue

                        candidates.append((int(c['cid']), str(c['text'])))

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
                        candidates.insert(0, (cluster_id, f"{title} {desc}".strip()))
                        # keep newly created cluster as candidate within the same ingest cycle
                        try:
                            candidates_meta.append({
                                "cid": cluster_id,
                                "text": f"{title} {desc}".strip(),
                                "topic": a_topic,
                                "latest_published_at": art.get('published_at'),
                                "entities": a_ents,
                                "is_liveblog": bool(is_liveblog),
                            })
                        except Exception:
                            pass

                linked = db.link_cluster_article(cluster_id, aid)
                if linked:
                    touched_clusters.add(cluster_id)

        stats["clusters_touched"] = len(touched_clusters)

        # =========================================================
        # ✅ NEW: merge accidental duplicate clusters (same story split)
        # Runs only on clusters touched in this cycle to keep it fast.
        # =========================================================
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.metrics.pairwise import cosine_similarity

            merge_sim = float(os.getenv("CLUSTER_MERGE_SIM", "0.78"))
            merge_min_j = float(os.getenv("CLUSTER_MERGE_MIN_ENTITY_JACCARD", "0.10"))
            merge_hours = int(os.getenv("CLUSTER_MERGE_WINDOW_HOURS", "96"))

            def _cluster_repr(cid: int) -> tuple[str, set[str], datetime | None, str, str]:
                meta = db.get_cluster_meta(cid)
                title = (meta.get("title") or "").strip()
                topic = (meta.get("topic") or "general").strip().lower()
                country = (meta.get("country") or "world").strip().lower()
                latest = db.get_cluster_latest_published_at(cid)
                latest_dt = _parse_iso_dt(latest)
                txts = db.get_cluster_article_texts(cid, limit=8)
                blob = " ".join([title] + txts).strip()
                ents = _extract_entities(blob)
                return blob, ents, latest_dt, topic, country

            # Group touched clusters by language
            touched_by_lang: dict[str, list[int]] = {}
            for cid in touched_clusters:
                m = db.get_cluster_meta(cid)
                lang = (m.get("language") or "en").lower()
                touched_by_lang.setdefault(lang, []).append(int(cid))

            for lang, cids in touched_by_lang.items():
                # Also include a small window of recent clusters, so we can merge with existing ones
                recent = db.list_recent_clusters(language=lang, limit=200)
                recent_ids = [int(r["id"]) for r in recent]
                pool_ids = list(dict.fromkeys(cids + recent_ids))  # stable unique

                # Build representations
                reprs: dict[int, dict] = {}
                texts: list[str] = []
                id_order: list[int] = []
                for cid in pool_ids:
                    blob, ents, latest_dt, topic, country = _cluster_repr(cid)
                    if not blob:
                        continue
                    reprs[cid] = {"text": blob, "ents": ents, "dt": latest_dt, "topic": topic, "country": country}
                    texts.append(blob)
                    id_order.append(cid)

                if len(texts) < 2:
                    continue

                # Char n-grams are robust to small wording changes
                vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=1)
                X = vec.fit_transform(texts)
                S = cosine_similarity(X)

                merged_any = True
                while merged_any:
                    merged_any = False
                    n = len(id_order)
                    for i in range(n):
                        for j in range(i + 1, n):
                            a = id_order[i]
                            b = id_order[j]
                            ra = reprs.get(a)
                            rb = reprs.get(b)
                            if not ra or not rb:
                                continue

                            # topic/country gate (allow general as wildcard)
                            if ra["country"] != rb["country"]:
                                continue
                            if ra["topic"] != rb["topic"] and "general" not in (ra["topic"], rb["topic"]):
                                continue

                            # time window gate
                            if ra["dt"] and rb["dt"] and abs(ra["dt"] - rb["dt"]) > timedelta(hours=merge_hours):
                                continue

                            # entity overlap gate
                            if len(ra["ents"]) >= 4 and len(rb["ents"]) >= 4:
                                if _jaccard(ra["ents"], rb["ents"]) < merge_min_j:
                                    continue

                            sim = float(S[i, j])
                            if sim < merge_sim:
                                continue

                            # Choose target: cluster with more sources (more stable), else newer id
                            sa = len(db.get_cluster_sources(a))
                            sb = len(db.get_cluster_sources(b))
                            target, source = (a, b) if (sa > sb or (sa == sb and a > b)) else (b, a)
                            db.merge_clusters(target, source)

                            # Update local state so we don't keep comparing removed clusters
                            if source in touched_clusters:
                                touched_clusters.discard(source)
                            touched_clusters.add(target)

                            # Remove source from working sets
                            if source in reprs:
                                reprs.pop(source, None)
                            if source in id_order:
                                idx = id_order.index(source)
                                id_order.pop(idx)
                                texts.pop(idx)
                                # Recompute similarity matrix because indices changed
                                if len(texts) >= 2:
                                    X = vec.fit_transform(texts)
                                    S = cosine_similarity(X)
                                merged_any = True
                                break
                        if merged_any:
                            break
        except Exception:
            stats["errors"] += 1
            logger.exception("cluster merge step failed")

        for cid in touched_clusters:
            try:
                meta = db.get_cluster_meta(cid)
                cluster_title = (meta.get("title") or "Event").strip()
                sources = db.get_cluster_sources(cid)
                score, details = compute_credibility(cluster_title=cluster_title, sources=sources)
                db.upsert_score(cluster_id=cid, credibility_score=score, details=details)
                stats["scores_updated"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("scoring failed for cluster_id=%s", cid)

        def uniq_sources_count(cid: int) -> int:
            return len({(s.get("source_name") or "").strip().lower() for s in db.get_cluster_sources(cid)})

        top_n = 12
        touched_sorted = sorted(list(touched_clusters), key=lambda x: uniq_sources_count(x), reverse=True)
        touched_sorted = [cid for cid in touched_sorted if uniq_sources_count(cid) >= 2][:top_n]

        # ✅ OG:image только для топ-12 событий (быстро и релевантно)
        try:
            og_budget = 12  # максимум 12 страниц за цикл

            for cid in touched_sorted:
                if og_budget <= 0:
                    break

                sources = db.get_cluster_sources(cid)

                # найдём любую статью без картинки и попробуем вытащить og:image
                for s in sources:
                    url = (s.get("url") or "").strip()
                    if not url:
                        continue

                    # если у этой статьи уже есть image_url — пропускаем
                    if (s.get("image_url") or "").strip():
                        continue

                    og_img = _extract_og_image_from_url(url)
                    if og_img:
                        # ВАЖНО: нужен метод в db.py (см. пункт 3 ниже)
                        db.update_article_image_url(int(s["id"]), og_img)
                        break  # достаточно одной картинки на событие

                og_budget -= 1

        except Exception:
            stats["errors"] += 1
            logger.exception("og:image enrichment failed")


        for cid in touched_sorted:
            try:
                meta = db.get_cluster_meta(cid)
                title = (meta.get("title") or "Event").strip()
                sources = db.get_cluster_sources(cid)

                stats["summaries_attempted"] += 1
                brief, summary_json, status, raw_text = summarize_cluster(
                    cluster_title=title,
                    sources=sources,
                    model="gpt-4o-mini",
                )
                db.upsert_summary(
                    cluster_id=cid,
                    summary_text=brief,
                    summary_json=summary_json,
                    raw_text=raw_text,
                    model="gpt-4o-mini",
                    status=status,
                )

                if status == "success":
                    stats["summaries_success"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("summary failed for cluster_id=%s", cid)

        try:
            cleanup = db.cleanup_old_data(keep_days=30)
            stats["cleanup"] = cleanup
        except Exception:
            stats["errors"] += 1
            logger.exception("cleanup failed")

        stats["finished_at"] = _utc_now_iso()
        db.finish_ingest_run(run_id, "success", stats)
        return stats

    except Exception:
        stats["errors"] += 1
        stats["finished_at"] = _utc_now_iso()
        logger.exception("Ingest cycle failed")
        db.finish_ingest_run(run_id, "failed", stats)
        return stats
