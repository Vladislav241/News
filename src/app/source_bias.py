
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Optional, Tuple
from urllib.parse import urlparse


from .db import db

logger = logging.getLogger("news.source_bias")


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _llm_enabled() -> bool:
    return _env_bool("MEDIA_BIAS_LLM_ENABLED", False)


def _llm_timeout_seconds() -> float:
    try:
        return max(1.0, min(10.0, float(os.getenv("MEDIA_BIAS_LLM_TIMEOUT_SECONDS", "4.5") or 4.5)))
    except Exception:
        return 4.5



def normalize_domain(url_or_domain: str) -> str:
    s = (url_or_domain or "").strip().lower()
    if not s:
        return ""
    s = s.replace("\u200b", "").strip()
    try:
        parsed = urlparse(s if "://" in s else f"http://{s}")
        host = parsed.hostname or s
    except Exception:
        host = s
    host = host.strip().lower().strip(".")
    host = host.split(":", 1)[0]
    host = re.sub(r"^www\d*\.", "", host)
    host = re.sub(r"^m\.", "", host)
    return host

def _load_seed_map() -> dict[str, dict[str, Any]]:
    try:
        p = Path(__file__).resolve().parent / "data" / "source_bias_seed.json"
        if not p.exists():
            return {}
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


_SEED = _load_seed_map()

# Source names coming from RSS often are not domains ("Daily Mail", "Washington Examiner", etc.).
# Resolve those stable names to canonical domains before hitting DB/seed/LLM.
_SOURCE_NAME_ALIASES: dict[str, str] = {
    "abc": "abcnews.go.com",
    "abc news": "abcnews.go.com",
    "axios": "axios.com",
    "bfmtv": "bfmtv.com",
    "bloomberg": "bloomberg.com",
    "cnbc": "cnbc.com",
    "daily mail": "dailymail.co.uk",
    "deutsche welle": "dw.com",
    "dw": "dw.com",
    "franceinfo": "franceinfo.fr",
    "france info": "franceinfo.fr",
    "france 24": "france24.com",
    "jerusalem post": "jpost.com",
    "le figaro": "lefigaro.fr",
    "le monde": "lemonde.fr",
    "npr": "npr.org",
    "pbs": "pbs.org",
    "pbs news": "pbs.org",
    "pbs newshour": "pbs.org",
    "politico": "politico.com",
    "sky news": "sky.com",
    "techmeme": "techmeme.com",
    "the guardian": "theguardian.com",
    "the hill": "thehill.com",
    "the washington examiner": "washingtonexaminer.com",
    "washington examiner": "washingtonexaminer.com",
}

_GENERIC_SOURCE_NAMES = {
    "news", "google news", "rss", "world", "general", "business", "technology",
    "science", "sports", "health", "politics", "unknown", "source"
}


def normalize_source_name(name: str) -> str:
    s = (name or "").strip().lower()
    if not s:
        return ""
    s = s.replace("&amp;", "&")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*[-|:].*$", "", s).strip()
    return s


def domain_from_source_name(name: str) -> str:
    key = normalize_source_name(name)
    if not key or key in _GENERIC_SOURCE_NAMES:
        return ""
    if key in _SOURCE_NAME_ALIASES:
        return _SOURCE_NAME_ALIASES[key]
    # Some feeds put a host-like value in source_name/source_key.
    if "." in key and " " not in key:
        return normalize_domain(key)
    return ""


def best_bias_domain(*, url: str = "", source_name: str = "", source_key: str = "", raw_json: Any = None) -> str:
    """Return the most stable domain for media-bias classification.

    Priority matters: source_name aliases are usually more reliable than article URLs
    from syndication/proxy pages. Then RSS feed URL from raw_json, then source_key,
    then final article URL.
    """
    for candidate in (
        domain_from_source_name(source_name),
        _extract_feed_domain(raw_json),
        domain_from_source_name(source_key),
        normalize_domain(source_key),
        normalize_domain(url),
    ):
        d = normalize_domain(candidate)
        if d:
            return _canonical_bias_domain(d)
    return ""


def _extract_feed_domain(raw_json: Any) -> str:
    try:
        if isinstance(raw_json, str) and raw_json.strip():
            raw_json = json.loads(raw_json)
        if not isinstance(raw_json, dict):
            return ""
        for key in ("feed_url", "rss_url", "source_url", "source_feed", "feed", "link"):
            val = raw_json.get(key)
            if isinstance(val, str) and val.strip():
                d = normalize_domain(val)
                if d:
                    return d
    except Exception:
        return ""
    return ""


_BIAS_EQUIVALENTS: dict[str, str] = {
    "bbc.co.uk": "bbc.com",
    "bbcnews.com": "bbc.com",
    "theguardian.co.uk": "theguardian.com",
    "guardian.co.uk": "theguardian.com",
    "dailymail.co.uk": "dailymail.co.uk",
    "dailymail.com": "dailymail.co.uk",
    "mailplus.co.uk": "dailymail.co.uk",
    "dw.com": "dw.com",
    "dw.de": "dw.com",
    "ft.com": "ft.com",
    "financialtimes.com": "ft.com",
    "france24.com": "france24.com",
    "france24.fr": "france24.com",
    "irishtimes.com": "irishtimes.com",
    "politico.eu": "politico.eu",
    "politico.com": "politico.com",
    "washingtonexaminer.com": "washingtonexaminer.com",
    "daily_mail": "dailymail.co.uk",
    "jerusalem_post": "jpost.com",
    "washington_examiner": "washingtonexaminer.com",
    "abcnews.go.com": "abcnews.go.com",
    "abcnews.com": "abcnews.go.com",
    "pbs.org": "pbs.org",
    "newshour.pbs.org": "pbs.org",
    "lemonde.fr": "lemonde.fr",
    "lefigaro.fr": "lefigaro.fr",
    "bfmtv.com": "bfmtv.com",
    "franceinfo.fr": "franceinfo.fr",
    "techmeme.com": "techmeme.com",
    "independent.co.uk": "independent.co.uk",
    "jpost.com": "jpost.com",
    "jerusalempost.com": "jpost.com",
    "euronews.com": "euronews.com",
    "news.sky.com": "sky.com",
    "feeds.skynews.com": "sky.com",
    "skynews.com": "sky.com",
    "axios.com": "axios.com",
    "nypost.com": "nypost.com",
    "npr.org": "npr.org",
    "marketwatch.com": "marketwatch.com",
    "hackernews.com": "hackernews.com",
    "thehackernews.com": "hackernews.com",
    "aljazeera.com": "aljazeera.com",
    "aljazeera.net": "aljazeera.com",
    "bloomberg.com": "bloomberg.com",
    "thehill.com": "thehill.com",
    "cnbc.com": "cnbc.com",
    "metro.co.uk": "metro.co.uk",
    "belfasttelegraph.co.uk": "belfasttelegraph.co.uk",
    "standard.co.uk": "standard.co.uk",
    "eveningstandard.co.uk": "standard.co.uk",
    "mirror.co.uk": "mirror.co.uk",
    "dailymirror.co.uk": "mirror.co.uk",
    "telegraph.co.uk": "telegraph.co.uk",
    "express.co.uk": "express.co.uk",
    "dailyexpress.co.uk": "express.co.uk",
}



def _canonical_bias_domain(domain: str) -> str:
    d = normalize_domain(domain)
    if not d:
        return ""
    if d in _BIAS_EQUIVALENTS:
        return _BIAS_EQUIVALENTS[d]
    parts = d.split(".")
    if len(parts) >= 3:
        for i in range(1, len(parts) - 1):
            cand = ".".join(parts[i:])
            if cand in _BIAS_EQUIVALENTS:
                return _BIAS_EQUIVALENTS[cand]
            if cand in _SEED:
                return cand
    return d


def get_bias_seed_version() -> str:
    try:
        items = {
            "seed": sorted((str(k), str((v or {}).get("bias") or "")) for k, v in _SEED.items()),
            "aliases": sorted((str(k), str(v)) for k, v in _SOURCE_NAME_ALIASES.items()),
            "resolver": "llm-batch-v2",
        }
        payload = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        return __import__("hashlib").sha1(payload.encode("utf-8")).hexdigest()[:12]
    except Exception:
        return "seed0"

def resolve_bias(domain: str, sample_titles: list[str] | None = None, allow_llm: bool = True) -> tuple[str, float, str]:
    """
    Returns: (bias, confidence, source)
    bias: left|center|right|unknown
    source: db|dataset|llm|unknown
    """
    original_d = normalize_domain(domain)
    d = _canonical_bias_domain(domain)
    if not d:
        return ("unknown", 0.0, "unknown")

    # 1) DB
    # Important: do not let old "unknown" rows permanently poison the resolver.
    # Earlier versions stored unknown when the LLM was disabled/timed out; if we
    # return that immediately, newer shipped seed entries can never repair the
    # widget and Media Bias keeps showing Unknown forever. Known labels are still
    # trusted and returned fast. Unknown rows fall through to seed/LLM below.
    try:
        row = db.get_source_bias(d)
        if row:
            rbias = str(row.get("bias") or "").lower()
            if rbias in ("left", "center", "right"):
                return (rbias, float(row.get("confidence") or 0.0), str(row.get("source") or "db"))
    except Exception:
        pass

    # 2) Seed dataset (shipped with the app; extendable)
    if d in _SEED:
        rec = _SEED[d] or {}
        bias = str(rec.get("bias") or "unknown").lower()
        conf = float(rec.get("confidence") or 0.0)
        src = str(rec.get("source") or "dataset")
        try:
            db.upsert_source_bias(d, bias, conf, src)
            if original_d and original_d != d:
                db.upsert_source_bias(original_d, bias, conf, src)
        except Exception:
            logger.exception("Failed to store seeded media bias for %s", d)
        return (bias, conf, "dataset")

    # Also try a suffix match for common cases (e.g. edition.cnn.com -> cnn.com)
    try:
        parts = d.split(".")
        if len(parts) >= 3:
            for i in range(1, len(parts)-1):
                cand = ".".join(parts[i:])
                if cand in _SEED:
                    rec = _SEED[cand] or {}
                    bias = str(rec.get("bias") or "unknown").lower()
                    conf = float(rec.get("confidence") or 0.0)
                    src = str(rec.get("source") or "dataset")
                    try:
                        db.upsert_source_bias(d, bias, conf, src)
                        if original_d and original_d != d:
                            db.upsert_source_bias(original_d, bias, conf, src)
                    except Exception:
                        logger.exception("Failed to store suffix media bias for %s via %s", d, cand)
                    return (bias, conf, "dataset")
    except Exception:
        pass

    # 3) LLM (best-effort; cached in DB)
    # Request-path callers may disable this to keep widgets/feed responsive.
    if not allow_llm:
        return ("unknown", 0.0, "unknown")

    bias, conf = classify_with_llm(d, sample_titles=sample_titles or [])
    try:
        # Persist only useful classifications. Do not permanently store fresh
        # unknown rows: API quota/timeouts would otherwise poison the widget and
        # prevent future seed/LLM improvements from taking effect. Existing old
        # unknown rows are already ignored above.
        if bias in ("left", "center", "right"):
            db.upsert_source_bias(d, bias, conf, "llm")
            if original_d and original_d != d:
                db.upsert_source_bias(original_d, bias, conf, "llm")
    except Exception:
        logger.exception("Failed to store LLM media bias for %s", d)
    return (bias, conf, "llm" if bias != "unknown" else "unknown")


def _bias_model_name() -> str:
    return (os.getenv("OPENAI_BIAS_MODEL") or os.getenv("OPENAI_CLUSTER_MATCH_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4.1-nano").strip()


def _extract_json_object(text: str) -> Any:
    txt = (text or "").strip()
    if not txt:
        raise ValueError("empty LLM response")
    if txt.startswith("{") or txt.startswith("["):
        return json.loads(txt)
    m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", txt)
    if not m:
        raise ValueError("no JSON in LLM response")
    return json.loads(m.group(1))


def _coerce_bias_result(obj: Any) -> tuple[str, float]:
    if not isinstance(obj, dict):
        return ("unknown", 0.0)
    bias = str(obj.get("bias") or "unknown").strip().lower()
    if bias not in ("left", "center", "right", "unknown"):
        bias = "unknown"
    try:
        conf = float(obj.get("confidence") or 0.0)
    except Exception:
        conf = 0.0
    conf = max(0.0, min(1.0, conf))
    # Honesty guard: do not persist a forced vector as fact when the model itself is unsure.
    if bias in ("left", "center", "right") and conf < 0.35:
        return ("unknown", conf)
    return (bias, conf)


def classify_with_llm(domain: str, sample_titles: list[str]) -> tuple[str, float]:
    result = classify_many_with_llm({domain: sample_titles or []})
    return result.get(normalize_domain(domain), ("unknown", 0.0))


def classify_many_with_llm(domain_titles: dict[str, list[str]]) -> dict[str, tuple[str, float]]:
    """Classify many unknown outlets in one cheap deterministic API call.

    This is the production-safe path: each unresolved domain costs at most one batch
    classification call, then the result is persisted in source_bias forever and the
    widget reads from DB/seed on later requests.
    """
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key or not _llm_enabled():
        return {}

    clean: dict[str, list[str]] = {}
    for domain, titles in (domain_titles or {}).items():
        d = _canonical_bias_domain(domain)
        if not d or d in clean:
            continue
        clean[d] = [str(t).strip()[:180] for t in (titles or []) if str(t).strip()][:5]
    if not clean:
        return {}

    from openai import OpenAI

    outlets = []
    for d, titles in clean.items():
        outlets.append({"domain": d, "headlines": titles})

    prompt = (
        "Classify political/editorial media bias for each news outlet.\n"
        "Use the outlet's known editorial reputation and the provided recent headlines only as supporting context.\n"
        "Allowed bias labels: left, center, right, unknown.\n"
        "Be honest: use unknown only when the outlet is not a real news outlet, is too obscure, or evidence is insufficient.\n"
        "For mainstream established outlets, choose the best vector with confidence.\n"
        "Return ONLY JSON: {\"results\":[{\"domain\":\"...\",\"bias\":\"left|center|right|unknown\",\"confidence\":0.0-1.0}]}\n\n"
        f"Outlets: {json.dumps(outlets, ensure_ascii=False)}"
    )

    try:
        client = OpenAI(api_key=api_key, timeout=_llm_timeout_seconds())
        resp = client.chat.completions.create(
            model=_bias_model_name(),
            messages=[
                {"role": "system", "content": "You are a careful, non-partisan media bias classifier. Return strict JSON only. Never invent domains."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=max(180, min(1400, 90 * len(clean))),
        )
        txt = (resp.choices[0].message.content or "").strip()
        obj = _extract_json_object(txt)
        rows = obj.get("results") if isinstance(obj, dict) else obj
        out: dict[str, tuple[str, float]] = {}
        if isinstance(rows, list):
            for item in rows:
                if not isinstance(item, dict):
                    continue
                d = _canonical_bias_domain(str(item.get("domain") or ""))
                if d not in clean:
                    continue
                bias, conf = _coerce_bias_result(item)
                out[d] = (bias, conf)
        return out
    except Exception:
        logger.warning("LLM batch media-bias classification failed for %d domains", len(clean), exc_info=True)
        return {}


def persist_llm_bias_results(results: dict[str, tuple[str, float]], aliases: dict[str, str] | None = None) -> int:
    saved = 0
    aliases = aliases or {}
    for domain, pair in (results or {}).items():
        d = _canonical_bias_domain(domain)
        bias, conf = pair
        if bias not in ("left", "center", "right"):
            continue
        try:
            db.upsert_source_bias(d, bias, float(conf), "llm")
            saved += 1
            for alias, canonical in aliases.items():
                if _canonical_bias_domain(canonical) == d:
                    a = normalize_domain(alias)
                    if a and a != d:
                        db.upsert_source_bias(a, bias, float(conf), "llm")
        except Exception:
            logger.exception("Failed to persist LLM media bias for %s", d)
    return saved
