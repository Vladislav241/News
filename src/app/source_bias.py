
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
    # If it's a URL, parse hostname
    try:
        if "://" in s:
            host = urlparse(s).hostname or ""
        else:
            host = s
    except Exception:
        host = s
    host = host.strip().lower()
    host = re.sub(r"^www\.", "", host)
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


def resolve_bias(domain: str, sample_titles: list[str] | None = None) -> tuple[str, float, str]:
    """
    Returns: (bias, confidence, source)
    bias: left|center|right|unknown
    source: db|dataset|llm|unknown
    """
    d = normalize_domain(domain)
    if not d:
        return ("unknown", 0.0, "unknown")

    # 1) DB
    try:
        row = db.get_source_bias(d)
        if row and row.get("bias") in ("left", "center", "right", "unknown"):
            return (str(row.get("bias")), float(row.get("confidence") or 0.0), str(row.get("source") or "db"))
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
        except Exception:
            pass
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
                    except Exception:
                        pass
                    return (bias, conf, "dataset")
    except Exception:
        pass

    # 3) LLM (best-effort; cached in DB)
    bias, conf = classify_with_llm(d, sample_titles=sample_titles or [])
    try:
        db.upsert_source_bias(d, bias, conf, "llm" if bias != "unknown" else "unknown")
    except Exception:
        pass
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
