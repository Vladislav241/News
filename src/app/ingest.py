# src/app/ingest.py
from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup

from .ai import summarize_cluster
from .clustering import canonical_cluster_key, match_cluster, normalize_title_for_key
from .db import db
from .scoring import compute_credibility

logger = logging.getLogger("news.ingest")

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

    return title, desc, content


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
        parsed = feedparser.parse(url, request_headers=headers)
        bozo = int(getattr(parsed, "bozo", 0) or 0)
        bozo_exc = None

        if bozo:
            bozo_exc = str(getattr(parsed, "bozo_exception", None))
            logger.warning("RSS bozo for %s: %s", name, bozo_exc)

        out: list[dict[str, Any]] = []
        entries = list(parsed.entries or [])

        for entry in entries[:per_feed]:
            link = (getattr(entry, "link", None) or "").strip()
            if not link:
                continue

            title, desc, content = _safe_entry_text(entry)
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
            "bozo_exception": bozo_exc,
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
            candidates: list[tuple[int, str]] = []

            for c in candidates_db:
                cid = int(c["id"])
                txts = db.get_cluster_article_texts(cid, limit=10)
                ctext = " ".join([(c.get("title") or "")] + txts).strip()
                candidates.append((cid, ctext))

            for aid in aids:
                art = db.get_article_by_id(aid)
                title = (art.get("title") or "").strip()
                desc = (art.get("description") or "").strip()
                content = (art.get("content") or "").strip()[:400]
                article_text = f"{title} {desc} {content}".strip()

                norm_title = normalize_title_for_key(title, lang)
                cluster_key = canonical_cluster_key(lang, norm_title or title[:120])

                existing = db.connect().execute(
                    "SELECT id FROM clusters WHERE cluster_key=?",
                    (cluster_key,),
                ).fetchone()

                if existing:
                    cluster_id = int(existing["id"])
                else:
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
                        candidates.insert(0, (cluster_id, f"{title} {desc} {content}".strip()))

                linked = db.link_cluster_article(cluster_id, aid)
                if linked:
                    touched_clusters.add(cluster_id)

        stats["clusters_touched"] = len(touched_clusters)

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
            entries, meta = _fetch_rss_feed(f)
            meta.update({"country": f["country"], "language": f["language"], "topic": f["topic"]})
            stats["feeds_meta"].append(meta)

            for a in entries:
                a["country"] = f["country"]
                a["language"] = f["language"]
                a["topic"] = f["topic"]
            all_articles.extend(entries)

        stats["articles_seen"] = len(all_articles)

        inserted_ids: list[int] = []
        for a in all_articles:
            try:
                aid = db.insert_article_if_new(a)
                if aid:
                    inserted_ids.append(aid)
                    stats["articles_inserted"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("insert_article_if_new failed")

        touched_clusters: set[int] = set()
        inserted_by_lang: dict[str, list[int]] = {}

        for aid in inserted_ids:
            art = db.get_article_by_id(aid)
            lang = (art.get("language") or "en").lower()
            inserted_by_lang.setdefault(lang, []).append(aid)

        for lang, aids in inserted_by_lang.items():
            candidates_db = db.list_recent_clusters(language=lang, limit=900)
            candidates: list[tuple[int, str]] = []

            for c in candidates_db:
                cid = int(c["id"])
                txts = db.get_cluster_article_texts(cid, limit=10)
                ctext = " ".join([(c.get("title") or "")] + txts)
                candidates.append((cid, ctext))

            for aid in aids:
                art = db.get_article_by_id(aid)
                title = art.get("title") or ""
                desc = art.get("description") or ""
                content = (art.get("content") or "")[:400]
                article_text = f"{title} {desc} {content}".strip()

                norm_title = normalize_title_for_key(title, lang)
                cluster_key = canonical_cluster_key(lang, norm_title or title[:120])

                existing = db.connect().execute(
                    "SELECT id FROM clusters WHERE cluster_key=?",
                    (cluster_key,),
                ).fetchone()

                if existing:
                    cid = int(existing["id"])
                else:
                    m = match_cluster(article_text, candidates, SIMILARITY_THRESHOLD)
                    cid = int(m.cluster_id) if m.cluster_id else db.upsert_cluster(
                        cluster_key=cluster_key,
                        title=title or "Untitled event",
                        topic=art.get("topic"),
                        country=art.get("country"),
                        language=lang,
                    )

                if db.link_cluster_article(cid, aid):
                    touched_clusters.add(cid)

        stats["clusters_touched"] = len(touched_clusters)

        for cid in touched_clusters:
            try:
                meta = db.get_cluster_meta(cid)
                title = meta.get("title") or "Event"
                sources = db.get_cluster_sources(cid)
                score, details = compute_credibility(title, sources)
                db.upsert_score(cid, score, details)
                stats["scores_updated"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("scoring failed")

        top = sorted(
            touched_clusters,
            key=lambda c: len(db.get_cluster_sources(c)),
            reverse=True,
        )[:12]

        for cid in top:
            try:
                meta = db.get_cluster_meta(cid)
                sources = db.get_cluster_sources(cid)
                stats["summaries_attempted"] += 1

                brief, summary_json, status, raw = summarize_cluster(
                    cluster_title=meta.get("title"),
                    sources=sources,
                    model="gpt-4o-mini",
                )

                db.upsert_summary(
                    cluster_id=cid,
                    summary_text=brief,
                    summary_json=summary_json,
                    raw_text=raw,
                    model="gpt-4o-mini",
                    status=status,
                )

                if status == "success":
                    stats["summaries_success"] += 1
            except Exception:
                stats["errors"] += 1
                logger.exception("summary failed")

        stats["finished_at"] = _utc_now_iso()
        db.finish_ingest_run(run_id, "success", stats)
        return stats

    except Exception:
        stats["errors"] += 1
        stats["finished_at"] = _utc_now_iso()
        logger.exception("Ingest failed")
        db.finish_ingest_run(run_id, "failed", stats)
        return stats

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
