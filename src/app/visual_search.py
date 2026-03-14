from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Iterable

from PIL import Image, UnidentifiedImageError

from .ai import extract_visual_search_signal
from .db import db

log = logging.getLogger("news.visual_search")

ALLOWED_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}
MAX_IMAGE_BYTES = 12 * 1024 * 1024

_UI_NOISE_PATTERNS = [
    r"\b(sign in|log in|subscribe|open app|share|comments?|reply|retweet|repost|menu|search|home|live|breaking|follow|read more)\b",
    r"\b(cookie|privacy policy|terms of use|accept all|allow all)\b",
    r"\b(hours? ago|mins? ago|minutes? ago|just now)\b",
    r"https?://\S+",
    r"\b(www\.)\S+",
    r"\b(advertisement|sponsored)\b",
]

_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "about", "your", "have", "will",
    "after", "before", "over", "under", "when", "where", "what", "which", "while", "they", "their",
    "says", "said", "amid", "into", "against", "more", "than", "then", "just", "news", "live",
    "video", "photo", "images", "image", "story", "article", "update", "latest", "breaking", "read",
    "для", "это", "как", "что", "при", "после", "після", "цей", "ця", "those", "these", "eine",
    "einer", "einem", "der", "die", "das", "und", "mit", "von", "nach", "pour", "avec", "dans",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class VisualSearchError(RuntimeError):
    def __init__(self, message: str, *, code: str = "visual_search_error", status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class StageTimer:
    def __init__(self) -> None:
        self.started_at = time.perf_counter()
        self.timings_ms: dict[str, int] = {}

    def mark(self, name: str, started: float) -> None:
        self.timings_ms[name] = int(max(0, round((time.perf_counter() - started) * 1000)))

    def finish(self) -> dict[str, int]:
        self.timings_ms.setdefault("total", int(max(0, round((time.perf_counter() - self.started_at) * 1000))))
        return dict(self.timings_ms)


def _normalize_text(text: str) -> str:
    s = str(text or "")
    s = s.replace("\u00a0", " ")
    s = re.sub(r"[\t\r\n]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()



def _normalize_for_match(text: str) -> str:
    s = _normalize_text(text).lower()
    s = s.replace("ё", "е")
    s = re.sub(r"[“”„‟«»]", '"', s)
    return s



def _tokenize(text: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for tok in re.split(r"[^\w#@%+\-/]+", _normalize_for_match(text)):
        tok = tok.strip("-_/#@%+")
        if len(tok) < 3:
            continue
        if tok in _STOPWORDS:
            continue
        if tok.isdigit() and len(tok) < 4:
            continue
        if tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
    return out



def _char_ngrams(text: str, n: int = 3) -> set[str]:
    s = re.sub(r"\s+", "", _normalize_for_match(text))
    if not s:
        return set()
    if len(s) <= n:
        return {s}
    return {s[i:i+n] for i in range(0, len(s) - n + 1)}



def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter <= 0:
        return 0.0
    return inter / max(1, len(a | b))



def _safe_ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return float(SequenceMatcher(None, _normalize_for_match(a), _normalize_for_match(b)).ratio())



def _clip_words(text: str, min_words: int = 0, max_words: int = 14, max_chars: int = 140) -> str:
    s = _normalize_text(text)
    if not s:
        return ""
    words = s.split()
    if min_words and len(words) < min_words:
        return ""
    if len(words) > max_words:
        s = " ".join(words[:max_words])
    if len(s) > max_chars:
        s = s[:max_chars].rsplit(" ", 1)[0].strip() or s[:max_chars]
    return s.strip()



def _dedupe_keep_order(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = _normalize_text(value)
        if not value:
            continue
        key = _normalize_for_match(value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out



def validate_visual_image(raw: bytes, filename: str, mime_type: str) -> dict[str, Any]:
    if not raw:
        raise VisualSearchError("Uploaded image is empty.", code="empty_image", status_code=400)
    if len(raw) > MAX_IMAGE_BYTES:
        raise VisualSearchError("Image is too large. Maximum supported size is 12 MB.", code="image_too_large", status_code=413)
    mime = (mime_type or "").strip().lower()
    if mime not in ALLOWED_MIME_TYPES:
        raise VisualSearchError("Unsupported image format. Please upload PNG, JPG, JPEG or WEBP.", code="bad_image_type", status_code=400)
    try:
        with Image.open(__import__('io').BytesIO(raw)) as img:
            img.verify()
        with Image.open(__import__('io').BytesIO(raw)) as img2:
            width, height = img2.size
            fmt = str(img2.format or "").upper()
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise VisualSearchError("This image file looks corrupted or unreadable.", code="bad_image", status_code=400) from e
    if width < 32 or height < 32:
        raise VisualSearchError("The image is too small to analyze reliably.", code="image_too_small", status_code=400)
    return {
        "filename": filename,
        "mime_type": mime,
        "size_bytes": len(raw),
        "width": int(width),
        "height": int(height),
        "format": fmt,
        "sha1": hashlib.sha1(raw).hexdigest()[:16],
    }



def _clean_ocr_text(text: str) -> str:
    s = str(text or "")
    for pat in _UI_NOISE_PATTERNS:
        s = re.sub(pat, " ", s, flags=re.I)
    s = re.sub(r"([A-Za-zА-Яа-яІіЇїЄє])\-\s+([A-Za-zА-Яа-яІіЇїЄє])", r"\1\2", s)
    s = re.sub(r"\s*\|\s*", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()



def _split_candidate_lines(text: str) -> list[str]:
    chunks = re.split(r"(?<=[.!?])\s+|\n+|\s{2,}", str(text or ""))
    lines: list[str] = []
    for chunk in chunks:
        line = _normalize_text(chunk).strip("-–—•| ")
        if not line:
            continue
        if len(line) < 6:
            continue
        lines.append(line)
    return _dedupe_keep_order(lines)



def _extract_entities(text: str) -> list[str]:
    original = _normalize_text(text)
    if not original:
        return []
    parts = re.findall(r"\b([A-ZА-ЯІЇЄ][\w'’.-]{2,}(?:\s+[A-ZА-ЯІЇЄ][\w'’.-]{2,}){0,2}|[A-Z]{2,}|\d{4}|\d+(?:\.\d+)?%?)\b", original)
    return _dedupe_keep_order(parts)[:14]



def build_visual_search_signal(raw: bytes, mime_type: str, ui_lang: str) -> dict[str, Any]:
    model = (os.getenv("OPENAI_VISUAL_SEARCH_MODEL", "").strip() or os.getenv("OPENAI_MODEL", "gpt-4.1-mini"))
    signal = extract_visual_search_signal(image_bytes=raw, mime_type=mime_type, ui_lang=ui_lang, model=model)
    ocr_text = _clean_ocr_text(str(signal.get("text") or ""))
    query = _clip_words(str(signal.get("query") or ""), min_words=2, max_words=14, max_chars=120)
    if not query and ocr_text:
        lines = _split_candidate_lines(ocr_text)
        query = _clip_words(lines[0] if lines else ocr_text, min_words=2, max_words=14, max_chars=120)
    lines = _split_candidate_lines(ocr_text)
    headline = ""
    subheadline = ""
    if lines:
        headline = _clip_words(lines[0], min_words=2, max_words=14, max_chars=140)
        if len(lines) > 1:
            subheadline = _clip_words(lines[1], min_words=3, max_words=20, max_chars=180)
    entities = _extract_entities(" ".join([query, ocr_text]))
    source_name = ""
    for candidate in lines[:5]:
        if len(candidate.split()) <= 4 and candidate.isupper():
            source_name = candidate
            break
    return {
        "query": query,
        "text": ocr_text[:700],
        "language": str(signal.get("language") or "unknown").strip().lower() or "unknown",
        "confidence": max(0.0, min(1.0, float(signal.get("confidence") or 0.0))),
        "headline": headline,
        "subheadline": subheadline,
        "lines": lines[:10],
        "entities": entities,
        "source_name": source_name[:80],
    }



def build_query_candidates(signal: dict[str, Any]) -> list[str]:
    query = str(signal.get("query") or "")
    ocr_text = str(signal.get("text") or "")
    headline = str(signal.get("headline") or "")
    subheadline = str(signal.get("subheadline") or "")
    entities = [str(x) for x in (signal.get("entities") or []) if str(x).strip()]
    lines = [str(x) for x in (signal.get("lines") or []) if str(x).strip()]
    source_name = str(signal.get("source_name") or "")

    candidates: list[str] = []

    def add(value: str, *, min_words: int = 2, max_words: int = 16, max_chars: int = 140) -> None:
        v = _clip_words(value, min_words=min_words, max_words=max_words, max_chars=max_chars)
        if not v:
            return
        if v not in candidates:
            candidates.append(v)

    add(query)
    add(headline)
    add(f"{headline} {subheadline}", min_words=3, max_words=18, max_chars=160)
    if lines:
        add(lines[0])
        if len(lines) > 1:
            add(f"{lines[0]} {lines[1]}", min_words=4, max_words=18, max_chars=160)
        for line in lines[:5]:
            add(line, min_words=3, max_words=16, max_chars=150)
    if entities:
        add(" ".join(entities[:6]), min_words=2, max_words=10, max_chars=110)
        add(" ".join(entities[:10]), min_words=3, max_words=14, max_chars=140)
    tokens = _tokenize(ocr_text)
    if tokens:
        add(" ".join(tokens[:8]), min_words=3, max_words=8, max_chars=90)
        add(" ".join(tokens[:14]), min_words=4, max_words=14, max_chars=135)
    if source_name and headline:
        add(f"{source_name} {headline}", min_words=3, max_words=14, max_chars=140)
    return candidates[:8]



def _decorated_doc_text(item: dict[str, Any]) -> str:
    parts = [
        str(item.get("title") or ""),
        str(item.get("summary") or ""),
        str(item.get("primary_source") or ""),
        str(item.get("topic") or ""),
    ]
    for src in (item.get("sources") or []):
        parts.append(str(src.get("title") or ""))
        parts.append(str(src.get("source_name") or ""))
        parts.append(str(src.get("description") or ""))
    return _normalize_text(" ".join(p for p in parts if p))



def _pick_best_query(candidates: list[str], docs: list[str]) -> str:
    if not candidates:
        return ""
    if not docs:
        return candidates[0]
    docs_joined = "\n".join(docs[:180])
    docs_tokens = set(_tokenize(docs_joined))
    docs_norm = _normalize_for_match(docs_joined)
    best = candidates[0]
    best_score = -1.0
    for candidate in candidates:
        candidate_norm = _normalize_for_match(candidate)
        candidate_tokens = set(_tokenize(candidate))
        overlap = len(candidate_tokens & docs_tokens) / max(1, len(candidate_tokens))
        char_overlap = _jaccard(_char_ngrams(candidate, 3), _char_ngrams(docs_joined, 3))
        ratio = _safe_ratio(candidate, docs_joined[:3000])
        substring_bonus = 0.25 if candidate_norm and candidate_norm in docs_norm else 0.0
        compact_bonus = max(0.0, 0.08 - max(0, len(candidate.split()) - 10) * 0.01)
        score = overlap * 0.46 + char_overlap * 0.22 + ratio * 0.24 + substring_bonus + compact_bonus
        if score > best_score:
            best_score = score
            best = candidate
    return best



def _recency_bonus(item: dict[str, Any]) -> float:
    value = str(item.get("latest_published_at") or item.get("published_at") or "").strip()
    if not value:
        return 0.0
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        hours = max(0.0, (_utc_now() - dt.astimezone(timezone.utc)).total_seconds() / 3600.0)
        if hours <= 24:
            return 1.0
        if hours <= 72:
            return 0.7
        if hours <= 168:
            return 0.45
        if hours <= 360:
            return 0.2
    except Exception:
        return 0.0
    return 0.0



def _lang_match_bonus(signal_language: str, item_language: str) -> float:
    sig = (signal_language or "").strip().lower()
    doc = (item_language or "").strip().lower()
    if not sig or sig == "unknown" or not doc:
        return 0.0
    if sig == doc:
        return 1.0
    if {sig, doc} <= {"uk", "ru"}:
        return 0.35
    if {sig, doc} <= {"de", "en", "fr"}:
        return 0.2
    return 0.0



def _score_item(item: dict[str, Any], *, signal: dict[str, Any], chosen_query: str, candidates: list[str]) -> dict[str, Any]:
    doc_text = _decorated_doc_text(item)
    title = str(item.get("title") or "")
    summary = str(item.get("summary") or "")
    source_titles = [str(s.get("title") or "") for s in (item.get("sources") or [])]
    source_names = [str(s.get("source_name") or "") for s in (item.get("sources") or [])]
    descriptions = [str(s.get("description") or "") for s in (item.get("sources") or [])]
    doc_tokens = set(_tokenize(doc_text))
    query_tokens = set(_tokenize(chosen_query))
    ocr_tokens = set(_tokenize(str(signal.get("text") or "")))
    entity_tokens = set(_tokenize(" ".join(signal.get("entities") or [])))

    title_ratio = max(_safe_ratio(chosen_query, title), max((_safe_ratio(chosen_query, x) for x in source_titles), default=0.0))
    body_ratio = max(_safe_ratio(chosen_query, summary), max((_safe_ratio(chosen_query, x) for x in descriptions), default=0.0), _safe_ratio(str(signal.get("text") or "")[:320], doc_text[:1200]))
    token_overlap = len(query_tokens & doc_tokens) / max(1, len(query_tokens)) if query_tokens else 0.0
    ocr_overlap = len(ocr_tokens & doc_tokens) / max(1, min(len(ocr_tokens), 24)) if ocr_tokens else 0.0
    entity_overlap = len(entity_tokens & doc_tokens) / max(1, len(entity_tokens)) if entity_tokens else 0.0
    char_overlap = _jaccard(_char_ngrams(chosen_query, 3), _char_ngrams(doc_text, 3))

    title_norm = _normalize_for_match(title)
    chosen_norm = _normalize_for_match(chosen_query)
    exact_title_match = 1.0 if chosen_norm and chosen_norm in title_norm else 0.0
    exact_substring_match = 1.0 if chosen_norm and chosen_norm in _normalize_for_match(doc_text) else 0.0

    source_match = 0.0
    if signal.get("source_name"):
        source_query = _normalize_for_match(str(signal.get("source_name") or ""))
        if any(source_query and source_query in _normalize_for_match(name) for name in source_names):
            source_match = 1.0

    language_match = _lang_match_bonus(str(signal.get("language") or ""), str(item.get("language") or ""))
    recency = _recency_bonus(item)
    try:
        sources_count = max(0, int(item.get("sources_count") or 0))
    except Exception:
        sources_count = 0
    cluster_relatedness = min(1.0, math.log1p(sources_count) / math.log(6)) if sources_count > 0 else 0.0
    ocr_confidence = max(0.0, min(1.0, float(signal.get("confidence") or 0.0)))

    candidate_hit = 0.0
    for candidate in candidates[:6]:
        candidate_hit = max(candidate_hit, _safe_ratio(candidate, doc_text[:1600]))

    score01 = (
        title_ratio * 0.25
        + body_ratio * 0.17
        + token_overlap * 0.15
        + ocr_overlap * 0.10
        + entity_overlap * 0.10
        + char_overlap * 0.08
        + exact_title_match * 0.07
        + exact_substring_match * 0.03
        + source_match * 0.02
        + language_match * 0.01
        + recency * 0.01
        + cluster_relatedness * 0.005
        + candidate_hit * 0.015
        + ocr_confidence * 0.005
    )
    score01 = max(0.0, min(1.0, score01))
    reasons: list[str] = []
    if exact_title_match >= 1.0 or title_ratio >= 0.9:
        reasons.append("near-exact title")
    elif title_ratio >= 0.72:
        reasons.append("strong title overlap")
    if body_ratio >= 0.62:
        reasons.append("article text overlap")
    if entity_overlap >= 0.5:
        reasons.append("entity match")
    if source_match >= 1.0:
        reasons.append("source match")
    if not reasons and token_overlap >= 0.42:
        reasons.append("keyword overlap")

    return {
        "score01": round(score01, 6),
        "score": round(score01 * 100, 1),
        "reasons": reasons[:3],
        "features": {
            "title_similarity": round(title_ratio, 4),
            "body_similarity": round(body_ratio, 4),
            "token_overlap": round(token_overlap, 4),
            "entity_overlap": round(entity_overlap, 4),
            "ocr_overlap": round(ocr_overlap, 4),
            "char_overlap": round(char_overlap, 4),
            "exact_title_match": round(exact_title_match, 4),
            "exact_substring_match": round(exact_substring_match, 4),
            "source_match": round(source_match, 4),
            "language_match": round(language_match, 4),
            "recency_bonus": round(recency, 4),
            "cluster_relatedness": round(cluster_relatedness, 4),
            "candidate_similarity": round(candidate_hit, 4),
            "ocr_confidence": round(ocr_confidence, 4),
        },
    }



def classify_match_type(top_score01: float, second_score01: float, reasons: list[str]) -> str:
    if top_score01 >= 0.92 and ("near-exact title" in reasons or "strong title overlap" in reasons):
        return "exact"
    if top_score01 >= 0.74:
        return "high_confidence"
    if top_score01 >= 0.42:
        return "related"
    return "fallback"



def build_user_message(match_type: str, result_count: int) -> str:
    if match_type == "exact":
        return "Exact or near-exact article found."
    if match_type == "high_confidence":
        return "Strong matches found in your news database."
    if match_type == "related":
        return "We could not confirm the exact article, but found closely related coverage."
    if result_count:
        return "The screenshot was difficult to read, so we returned the best fallback matches we could find."
    return "We could not find a reliable match for this screenshot."



def search_visual_news(*, raw: bytes, filename: str, mime_type: str, ui_lang: str, interests: list[str], country: str, language: str, limit: int, decorate_item, translate_items, queue_missing_summaries, background_tasks, user) -> dict[str, Any]:
    timer = StageTimer()
    started = time.perf_counter()
    meta = validate_visual_image(raw, filename, mime_type)
    timer.mark("validate", started)

    log.info("visual search started file=%s mime=%s size=%s dims=%sx%s hash=%s", meta["filename"], meta["mime_type"], meta["size_bytes"], meta["width"], meta["height"], meta["sha1"])

    started = time.perf_counter()
    signal = build_visual_search_signal(raw, mime_type=mime_type, ui_lang=ui_lang)
    timer.mark("ocr_extract", started)

    if not signal.get("query") and not signal.get("text"):
        raise VisualSearchError("We could not read enough text from this screenshot.", code="ocr_empty", status_code=422)

    candidates = build_query_candidates(signal)
    if not candidates:
        raise VisualSearchError("We could not build a reliable search query from this screenshot.", code="no_candidates", status_code=422)

    log.info("visual search ocr chars=%s language=%s confidence=%.3f candidates=%s", len(str(signal.get("text") or "")), signal.get("language"), float(signal.get("confidence") or 0.0), candidates[:5])

    since_21 = (_utc_now() - __import__('datetime').timedelta(days=21)).isoformat()
    since_30 = (_utc_now() - __import__('datetime').timedelta(days=30)).isoformat()

    started = time.perf_counter()
    candidate_sets: list[list[dict[str, Any]]] = []
    try:
        candidate_sets.append(db.query_clusters(interests=interests, country=country, language=language, since_iso=since_21, limit=350))
    except Exception:
        log.exception("visual search scope query failed: scoped")
        candidate_sets.append([])
    try:
        candidate_sets.append(db.query_clusters(interests=[], country=country if country != "world" else "", language="all", since_iso=since_21, limit=350))
    except Exception:
        log.exception("visual search scope query failed: country")
        candidate_sets.append([])
    try:
        candidate_sets.append(db.query_clusters(interests=[], country="", language="all", since_iso=since_30, limit=450))
    except Exception:
        log.exception("visual search scope query failed: global")
        candidate_sets.append([])
    timer.mark("candidate_fetch", started)

    dedup_rows: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for group in candidate_sets:
        for row in group or []:
            try:
                cid = int(row.get("id") or 0)
            except Exception:
                cid = 0
            if cid <= 0 or cid in seen_ids:
                continue
            seen_ids.add(cid)
            dedup_rows.append(row)
            if len(dedup_rows) >= 500:
                break
        if len(dedup_rows) >= 500:
            break

    started = time.perf_counter()
    queue_missing_summaries(dedup_rows[:12], background_tasks, max_jobs=4)
    timer.mark("summary_queue", started)

    started = time.perf_counter()
    is_guest = user is None
    decorated: list[dict[str, Any]] = []
    for idx, row in enumerate(dedup_rows):
        include_sources = (not is_guest) or idx < 3
        try:
            decorated.append(decorate_item(row, include_sources=include_sources))
        except Exception:
            log.exception("visual search decorate failed cluster=%s", row.get("id"))
    timer.mark("decorate", started)

    docs = [_decorated_doc_text(item) for item in decorated]
    chosen_query = _pick_best_query(candidates, docs)
    if not chosen_query:
        chosen_query = candidates[0]

    started = time.perf_counter()
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in decorated:
        detail = _score_item(item, signal=signal, chosen_query=chosen_query, candidates=candidates)
        item["similarity"] = detail["score01"]
        item["visual_match_score"] = detail["score"]
        item["visual_match_reasons"] = detail["reasons"]
        item["visual_match_features"] = detail["features"]
        scored.append((detail["score01"], item))
    scored.sort(key=lambda x: (x[0], int(x[1].get("credibility_score") or 0), int(x[1].get("sources_count") or 0), str(x[1].get("latest_published_at") or "")), reverse=True)
    timer.mark("rerank", started)

    top_score = float(scored[0][0]) if scored else 0.0
    second_score = float(scored[1][0]) if len(scored) > 1 else 0.0
    match_type = classify_match_type(top_score, second_score, list((scored[0][1].get("visual_match_reasons") or [])) if scored else [])

    started = time.perf_counter()
    if top_score >= 0.74:
        filtered = [item for score, item in scored if score >= 0.34]
    elif top_score >= 0.42:
        filtered = [item for score, item in scored if score >= 0.22]
    else:
        filtered = [item for _, item in scored[: min(24, len(scored))]]
    filtered = filtered[: max(1, min(200, int(limit or 60)))]
    timer.mark("fallback_filter", started)

    if ui_lang and filtered:
        started = time.perf_counter()
        try:
            translated = translate_items(filtered, ui_lang=ui_lang)
            if translated is not None:
                filtered = translated
        except Exception:
            log.exception("visual search translation failed")
        timer.mark("translate", started)

    timings = timer.finish()
    log.info("visual search finished chosen=%r candidates=%s top_score=%.3f match_type=%s results=%s timings_ms=%s", chosen_query, candidates[:5], top_score, match_type, len(filtered), timings)

    results = []
    for item in filtered:
        results.append(item)

    return {
        "ok": True,
        "status": "ok",
        "query_used": chosen_query,
        "query": chosen_query,
        "ocr_preview": str(signal.get("text") or "")[:300],
        "ocr_text": str(signal.get("text") or "")[:700],
        "ocr_language": signal.get("language") or "unknown",
        "ocr_confidence": round(float(signal.get("confidence") or 0.0), 4),
        "match_type": match_type,
        "message": build_user_message(match_type, len(results)),
        "count": len(results),
        "results": results,
        "items": results,
        "filename": meta["filename"],
        "image_meta": {
            "mime_type": meta["mime_type"],
            "size_bytes": meta["size_bytes"],
            "width": meta["width"],
            "height": meta["height"],
        },
        "debug": {
            "candidates": candidates,
            "headline": signal.get("headline") or "",
            "subheadline": signal.get("subheadline") or "",
            "entities": signal.get("entities") or [],
            "source_name": signal.get("source_name") or "",
            "timings_ms": timings,
            "result_scores": [
                {
                    "cluster_id": item.get("cluster_id") or item.get("event_id"),
                    "score": item.get("visual_match_score"),
                    "reasons": item.get("visual_match_reasons") or [],
                }
                for item in results[:10]
            ],
        },
    }
