
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
        items = sorted((str(k), str((v or {}).get("bias") or "")) for k, v in _SEED.items())
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


def classify_with_llm(domain: str, sample_titles: list[str]) -> tuple[str, float]:
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key or not _llm_enabled():
        return ("unknown", 0.0)

    # Import lazily so dev runs without the package don't crash.
    from openai import OpenAI

    # Keep the prompt short and deterministic to reduce tokens/cost.
    # We do NOT browse; we classify using domain + a few recent headlines from our own corpus.
    headlines = [t.strip() for t in (sample_titles or []) if (t or "").strip()][:6]
    bullets = "\n".join([f"- {h[:180]}" for h in headlines]) if headlines else "- (no headlines available)"

    prompt = (
        "Classify the political media bias of the news outlet by domain.\n"
        "Allowed labels: left, center, right, unknown.\n"
        "Return ONLY JSON with keys: bias, confidence.\n"
        "confidence must be a number 0..1.\n\n"
        f"Domain: {domain}\n"
        "Recent headlines from this outlet (may be incomplete):\n"
        f"{bullets}\n"
    )

    try:
        client = OpenAI(api_key=api_key, timeout=_llm_timeout_seconds())
        resp = client.chat.completions.create(
            model=(os.getenv("OPENAI_BIAS_MODEL") or os.getenv("OPENAI_CLUSTER_MATCH_MODEL") or "gpt-4.1-nano"),
            messages=[
                {"role": "system", "content": "You are a careful media bias classifier. If unsure, answer unknown with low confidence."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=80,
        )
        txt = (resp.choices[0].message.content or "").strip()
        obj = json.loads(txt) if txt.startswith("{") else json.loads(re.search(r"\{[\s\S]*\}", txt).group(0))
        bias = str(obj.get("bias") or "unknown").strip().lower()
        if bias not in ("left", "center", "right", "unknown"):
            bias = "unknown"
        conf = float(obj.get("confidence") or 0.0)
        conf = max(0.0, min(1.0, conf))
        return (bias, conf)
    except Exception:
        logger.exception("LLM bias classification failed for %s", domain)
        return ("unknown", 0.0)
