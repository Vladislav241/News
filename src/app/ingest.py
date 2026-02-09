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

from .ai import summarize_cluster
from .clustering import canonical_cluster_key, match_cluster, normalize_title_for_key
from .db import db
from .scoring import compute_credibility

logger = logging.getLogger("news.ingest")

# =========================================================
# RSS SOURCES
# =========================================================

DEFAULT_RSS_SOURCES: dict[str, Any] = {
    "world": {
        "en": {
            "general": [
                {"name": "AP Top News", "url": "https://apnews.com/hub/ap-top-news/rss"},
                {"name": "BBC World", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
                {"name": "The Guardian World", "url": "https://www.theguardian.com/world/rss"},
                {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
                {"name": "DW", "url": "https://rss.dw.com/rdf/rss-en-all"},
                # NOTE: Reuters does not provide an official free RSS for all content.
                # This mirror works sometimes but can be unstable.
                {"name": "Reuters World (Unofficial Mirror)", "url": "https://www.reutersagency.com/feed/?best-sectors=world&post_type=best"},
                {"name": "NYT World", "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"},
                {"name": "The Hill", "url": "https://thehill.com/feed/"},
                {"name": "Axios", "url": "https://api.axios.com/feed/"},
            ],
        }
    }
}

SIMILARITY_THRESHOLD = 0.33

# =========================================================
# CLUSTERING GATES HELPERS (cheap, offline)
# =========================================================

import re as _re

_CAP_SEQ_RE = _re.compile(
    r"\b(?:[A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+){0,3}|[A-ZА-ЯЁ]{2,}(?:\s+[A-ZА-ЯЁ]{2,}){0,2})\b"
)
_NOISE = {"the", "and", "for", "with", "from", "says", "said", "new", "news", "live", "update", "breaking"}


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
# IMAGE EXTRACTION (RSS only; avoid blocking)
# =========================================================


def _extract_og_image_from_url(url: str) -> str | None:
    try:
        resp = requests.get(url, timeout=6, headers={"User-Agent": "Mozilla/5.0 (NewsAggregator)"})
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


def _extract_image_url(entry: Any) -> str | None:
    """Fast image extraction from RSS only."""
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
                u = (m.get("url") or "").strip()
                if u:
                    return u

        media_thumb = getattr(entry, "media_thumbnail", None)
        if media_thumb:
            for m in media_thumb:
                u = (m.get("url") or "").strip()
                if u:
                    return u

        links = getattr(entry, "links", None) or []
        for l in links:
            href = (l.get("href") or "").strip()
            typ = (l.get("type") or "").strip().lower()
            if not href:
                continue
            looks_like_img = href.lower().split("?", 1)[0].endswith((".jpg", ".jpeg", ".png", ".webp"))
            if looks_like_img and (typ.startswith("image") or typ == ""):
                return href
    except Exception:
        return None

    return None


# =========================================================
# RSS FETCH (robust to TLS/EOF + non-XML anti-bot)
# =========================================================


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


def _looks_like_html(b: bytes) -> bool:
    head = (b or b"")[:400].lstrip().lower()
    return head.startswith(b"<html") or b"<!doctype" in head or b"<head" in head


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
        sess = requests

    h = dict(headers or {})
    h.setdefault('Accept-Language', 'en-US,en;q=0.9')
    # Some servers behave better without brotli; requests will transparently decode gzip/deflate.
    h.setdefault('Accept-Encoding', 'gzip, deflate')

    try:
        r = sess.get(u, headers=h, timeout=15, allow_redirects=True)
        fetch_meta['status_code'] = getattr(r, 'status_code', None)
        fetch_meta['content_type'] = (getattr(r, 'headers', {}) or {}).get('content-type')
        data = getattr(r, 'content', b'') or b''

        # If server returns HTML (anti-bot / paywall), don't feed it into feedparser.
        head = data[:200].lstrip().lower()
        if head.startswith(b'<!doctype html') or head.startswith(b'<html'):
            fetch_meta['is_html'] = True
            return feedparser.parse(b''), fetch_meta

        if data:
            return feedparser.parse(data), fetch_meta
    except Exception as e:
        fetch_meta['error'] = str(e)

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

        # OG IMAGE enrichment (limited, only for new articles)
        try:
            og_budget = 25
            for aid in inserted_article_ids:
                if og_budget <= 0:
                    break
                art = db.get_article_by_id(aid)
                if not art:
                    continue
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
            candidates_meta: list[dict[str, Any]] = []
            for c in candidates_db:
                cid = int(c["id"])
                txts = db.get_cluster_article_texts(cid, limit=10)
                ctext = " ".join([(c.get("title") or "")] + txts).strip()
                latest = db.get_cluster_latest_published_at(cid)
                c_topic = (c.get("topic") or "general").strip().lower()
                c_ents = _extract_entities(ctext)
                candidates_meta.append(
                    {
                        "cid": cid,
                        "text": ctext,
                        "topic": c_topic,
                        "latest_published_at": latest,
                        "entities": c_ents,
                        "is_liveblog": _is_liveblog(None, (c.get("title") or "")),
                    }
                )

            for aid in aids:
                art = db.get_article_by_id(aid)
                title = (art.get("title") or "").strip()
                desc = (art.get("description") or "").strip()
                article_text = f"{title} {desc}".strip()

                is_liveblog = _is_liveblog(art.get("url"), title)

                if is_liveblog:
                    cluster_key = _liveblog_cluster_key(lang, (art.get("url") or ""))
                else:
                    norm_title = normalize_title_for_key(title, lang)
                    if not norm_title:
                        # Broken feeds sometimes omit <title>. Never allow an empty cluster key.
                        norm_title = normalize_title_for_key(desc, lang)
                    if not norm_title:
                        norm_title = normalize_title_for_key(_guess_title_from_url(art.get("url") or ""), lang)
                    if not norm_title:
                        # Absolute last resort: stable per-URL key (prevents cross-topic merges).
                        u = (art.get("url") or "").split("#", 1)[0].split("?", 1)[0]
                        norm_title = "url:" + hashlib.sha1(u.encode("utf-8", errors="ignore")).hexdigest()[:16]
                    cluster_key = canonical_cluster_key(lang, norm_title)

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
                        if c_topic != a_topic and "general" not in (c_topic, a_topic):
                            continue

                        c_dt = _parse_iso_dt(c.get("latest_published_at"))
                        if a_dt and c_dt and abs(a_dt - c_dt) > timedelta(hours=hours):
                            continue

                        c_ents = c.get("entities") or set()
                        if len(a_ents) >= 4 and len(c_ents) >= 4:
                            if _jaccard(a_ents, c_ents) < min_j:
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
                stats["scores_updated"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("scoring failed for cluster_id=%s", cid)

        def uniq_sources_count(cid: int) -> int:
            return len({(s.get("source_name") or "").strip().lower() for s in db.get_cluster_sources(cid)})

        top_n = 12
        touched_sorted = sorted(list(touched_clusters), key=lambda x: uniq_sources_count(x), reverse=True)
        touched_sorted = [cid for cid in touched_sorted if uniq_sources_count(cid) >= 2][:top_n]

        # Summaries only for top clusters
        for cid in touched_sorted:
            try:
                meta = db.get_cluster_meta(cid)
                title = (meta.get("title") or "Event").strip()
                sources = db.get_cluster_sources(cid)

                stats["summaries_attempted"] += 1
                brief, summary_json, status, raw_text = summarize_cluster(
                    cluster_title=title,
                    sources=sources,
                    model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
                )
                db.upsert_summary(
                    cluster_id=cid,
                    summary_text=brief,
                    summary_json=summary_json,
                    raw_text=raw_text,
                    model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
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
