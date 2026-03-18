# src/app/clustering.py
from __future__ import annotations

import hashlib
import re
import os
import json
import time
from functools import lru_cache
from collections import OrderedDict
import logging

from datetime import datetime, timezone, timedelta

import numpy as np
import requests

from dataclasses import dataclass
from typing import Any

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.decomposition import TruncatedSVD

from .db import db

logger = logging.getLogger("news.clustering")
_log = logger  # backwards-compat alias
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)
logger.info("CLUSTER_LLM_ENABLED=%s OPENAI_API_KEY_set=%s OPENAI_MODEL=%s",
            os.getenv("CLUSTER_LLM_ENABLED"), bool(os.getenv("OPENAI_API_KEY")), os.getenv("OPENAI_MODEL"))

# ---- LLM decision cache (process-local) ----
# We cache ONLY the final boolean/score/reason by a stable hash, and we log only on cache-miss.
# This prevents log spam and repeated paid calls when the same pair is evaluated many times.
_LLM_DECISION_CACHE: "OrderedDict[str, tuple[float, tuple[bool | None, float, str]]]" = OrderedDict()
_LLM_DECISION_CACHE_MAX = int(os.getenv("CLUSTER_LLM_CACHE_MAX", "2048"))
_LLM_DECISION_CACHE_TTL_SEC = int(os.getenv("CLUSTER_LLM_CACHE_TTL_SEC", str(6 * 60 * 60)))  # 6h

# Simple rate-limit so a single ingest cycle can't explode into hundreds of LLM calls.
_LLM_WINDOW_START = 0.0
_LLM_CALLS_IN_WINDOW = 0
_LLM_MAX_CALLS_PER_MIN = int(os.getenv("CLUSTER_LLM_MAX_CALLS_PER_MIN", "12"))
_LLM_MAX_CALLS_PER_RUN = int(os.getenv("CLUSTER_LLM_MAX_CALLS_PER_RUN", "18"))
_LLM_RUN_CALLS = 0
_LLM_RUN_CACHE_HITS = 0
_LLM_RUN_SKIPPED = 0
_LLM_MIN_BORDERLINE_SIM = float(os.getenv("CLUSTER_LLM_MIN_BORDERLINE_SIM", "0.60"))
_LLM_MAX_BORDERLINE_SIM = float(os.getenv("CLUSTER_LLM_MAX_BORDERLINE_SIM", "0.86"))

def begin_llm_budget_window() -> None:
    global _LLM_WINDOW_START, _LLM_CALLS_IN_WINDOW, _LLM_RUN_CALLS, _LLM_RUN_CACHE_HITS, _LLM_RUN_SKIPPED
    _LLM_WINDOW_START = 0.0
    _LLM_CALLS_IN_WINDOW = 0
    _LLM_RUN_CALLS = 0
    _LLM_RUN_CACHE_HITS = 0
    _LLM_RUN_SKIPPED = 0


def get_llm_budget_stats() -> dict[str, int]:
    return {
        "llm_calls": int(_LLM_RUN_CALLS),
        "llm_cache_hits": int(_LLM_RUN_CACHE_HITS),
        "llm_skipped": int(_LLM_RUN_SKIPPED),
        "llm_max_calls_per_run": int(_LLM_MAX_CALLS_PER_RUN),
        "llm_max_calls_per_min": int(_LLM_MAX_CALLS_PER_MIN),
    }

def _llm_allow_call() -> bool:
    """
    Returns True if an LLM call is allowed right now.

    Conditions:
    - CLUSTER_LLM_ENABLED must be '1'
    - OPENAI_API_KEY must be set
    - simple per-process rate-limit (calls/min)

    This function exists mainly to avoid hard crashes and to protect your budget.
    """
    global _LLM_WINDOW_START, _LLM_CALLS_IN_WINDOW

    if os.getenv('CLUSTER_LLM_ENABLED', '0') != '1':
        return False
    if not os.getenv('OPENAI_API_KEY'):
        return False

    now = time.time()
    if _LLM_WINDOW_START <= 0 or (now - _LLM_WINDOW_START) >= 60.0:
        _LLM_WINDOW_START = now
        _LLM_CALLS_IN_WINDOW = 0

    global _LLM_RUN_CALLS, _LLM_RUN_SKIPPED

    if _LLM_CALLS_IN_WINDOW >= _LLM_MAX_CALLS_PER_MIN:
        _LLM_RUN_SKIPPED += 1
        return False
    if _LLM_RUN_CALLS >= _LLM_MAX_CALLS_PER_RUN:
        _LLM_RUN_SKIPPED += 1
        return False

    _LLM_CALLS_IN_WINDOW += 1
    _LLM_RUN_CALLS += 1
    return True

def _llm_cache_get(h: str) -> tuple[bool | None, float, str] | None:
    now = time.time()
    item = _LLM_DECISION_CACHE.get(h)
    if not item:
        return None
    ts, val = item
    if (now - ts) > _LLM_DECISION_CACHE_TTL_SEC:
        # expired
        try:
            _LLM_DECISION_CACHE.pop(h, None)
        except Exception:
            pass
        return None
    # refresh LRU
    try:
        _LLM_DECISION_CACHE.move_to_end(h)
    except Exception:
        pass
    return val

def _llm_cache_set(h: str, val: tuple[bool | None, float, str]) -> None:
    try:
        _LLM_DECISION_CACHE[h] = (time.time(), val)
        _LLM_DECISION_CACHE.move_to_end(h)
        while len(_LLM_DECISION_CACHE) > _LLM_DECISION_CACHE_MAX:
            _LLM_DECISION_CACHE.popitem(last=False)
    except Exception:
        pass


# ---- stopwords / normalization ----
# NOTE: стоп-слова чистим только для EN.
# Для RU/DE и прочих языков без нормального NLP лучше работает char n-gram TF-IDF.
_STOP_EN = {
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "from",
    "with", "as", "by", "is", "are", "was", "were", "be", "been", "it", "its",
    "this", "that", "these", "those", "after", "before", "over", "under", "into",
    "will", "says", "say", "said", "new", "live", "updates", "update", "breaking",
}


# ---- optional LLM arbiter (for borderline cluster merges) ----
# Enable with: CLUSTER_LLM_ENABLED=1 and set OPENAI_API_KEY.
# You can also override model with OPENAI_MODEL (default: gpt-5-mini).
_LLM_ENABLED = os.getenv("CLUSTER_LLM_ENABLED", "").strip() in {"1", "true", "yes", "on"}
_OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
_OPENAI_MODEL = os.getenv("OPENAI_CLUSTER_MATCH_MODEL", "").strip() or os.getenv("OPENAI_MODEL", "").strip() or "gpt-4.1-nano"
_OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1"

# Small in-process cache to avoid paying twice for the same pair.
# Key = sha1(normalized_a + "||" + normalized_b) with order normalization.
@lru_cache(maxsize=4096)
def _llm_same_event_cached(key: str) -> tuple[bool | None, float, str]:
    # Returns: (same_event or None on failure, confidence, rationale)
    if (not _LLM_ENABLED) or (not _OPENAI_API_KEY):
        return (None, 0.0, "llm_disabled_or_no_key")

    url = _OPENAI_BASE_URL.rstrip("/") + "/chat/completions"

    headers = {
        "Authorization": f"Bearer {_OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    # We keep prompts short: we only need a binary decision.
    # IMPORTANT: Do NOT send full article HTML. Use already-normalized text snippets.
    payload = {
    "model": _OPENAI_MODEL,
    "messages": [
        {
            "role": "system",
            "content": (
                "You are a strict news clustering arbiter. "
                "Decide if two snippets describe the SAME underlying news event (same incident/story), "
                "not merely the same broad topic. If different events, answer false."
            ),
        },
        {"role": "user", "content": key},
    ],
    "temperature": 0,
    "response_format": {
        "type": "json_schema",
        "json_schema": {
            "name": "same_event_schema",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "same_event": {"type": "boolean"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "rationale": {"type": "string"},
                },
                "required": ["same_event", "confidence", "rationale"],
                "additionalProperties": False,
            },
        },
    },
}


    try:
        r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=12)
        if r.status_code >= 400:
            # покажем текст ошибки, чтобы сразу понять причину
            return (None, 0.0, f"llm_http_{r.status_code}:{r.text[:200]}")

        data = r.json()

        # Chat Completions: ответ лежит здесь:
        out_text = ""
        try:
            out_text = data["choices"][0]["message"]["content"]
        except Exception:
            out_text = ""

        out_text = (out_text or "").strip()
        if not out_text:
            return (None, 0.0, "llm_empty")

        obj = json.loads(out_text)
        same = bool(obj.get("same_event"))
        conf = float(obj.get("confidence") or 0.0)
        rat = str(obj.get("rationale") or "")[:240]
        return (same, conf, rat)

    except Exception as e:
        return (None, 0.0, f"llm_exc:{type(e).__name__}")


def llm_same_event(snippet_a: str, snippet_b: str) -> tuple[bool | None, float, str]:
    """Public wrapper with process + DB cache and telemetry."""
    global _LLM_RUN_CACHE_HITS

    a = (snippet_a or "").strip()
    b = (snippet_b or "").strip()
    if not a or not b:
        return (None, 0.0, "llm_empty_input")
    if a > b:
        a, b = b, a
    a = a[:1200]
    b = b[:1200]
    prompt = f"""A:
{a}

B:
{b}

Return JSON."""
    h = hashlib.sha1(prompt.encode("utf-8", errors="ignore")).hexdigest()

    cached = _llm_cache_get(h)
    if cached is not None:
        _LLM_RUN_CACHE_HITS += 1
        try:
            db.log_ai_usage(feature="cluster_match", model=_OPENAI_MODEL, status="cache_hit_memory", cache_hit=True, meta={"cache_key": h[:12]})
        except Exception:
            pass
        return cached

    try:
        row = db.get_llm_pair_cache(h, "cluster_match")
    except Exception:
        row = None
    if row and isinstance(row.get("payload"), dict):
        payload = row.get("payload") or {}
        out = (
            payload.get("same_event"),
            float(payload.get("confidence") or 0.0),
            str(payload.get("reason") or "db_cache"),
        )
        _llm_cache_set(h, out)
        _LLM_RUN_CACHE_HITS += 1
        try:
            db.log_ai_usage(feature="cluster_match", model=_OPENAI_MODEL, status="cache_hit_db", cache_hit=True, meta={"cache_key": h[:12]})
        except Exception:
            pass
        return out

    if not _llm_allow_call():
        out = (None, 0.0, "llm_budget_limited")
        _llm_cache_set(h, out)
        try:
            db.log_ai_usage(feature="cluster_match", model=_OPENAI_MODEL, status="budget_limited", cache_hit=False, meta={"cache_key": h[:12]})
        except Exception:
            pass
        return out

    _log.info("[LLM] ARBITER TRIGGERED key=%s", h[:8])
    started = time.perf_counter()
    out = _llm_same_event_cached(prompt)
    latency_ms = int((time.perf_counter() - started) * 1000)
    _llm_cache_set(h, out)
    try:
        db.set_llm_pair_cache(
            h,
            "cluster_match",
            _OPENAI_MODEL,
            {"same_event": out[0], "confidence": out[1], "reason": out[2]},
            ttl_seconds=_LLM_DECISION_CACHE_TTL_SEC,
        )
        db.log_ai_usage(
            feature="cluster_match",
            model=_OPENAI_MODEL,
            status="success" if out[0] is not None else "failed",
            cache_hit=False,
            latency_ms=latency_ms,
            meta={"cache_key": h[:12], "reason": out[2]},
        )
    except Exception:
        pass
    return out

# Common prefixes / tails used by many feeds
_PREFIX_RE = re.compile(
    r"^(live updates?|live|analysis|opinion|update|breaking|exclusive)\s*[:\-—–]\s*",
    re.IGNORECASE,
)
_LIVE_WORDS_RE = re.compile(r"\b(live updates?|live|breaking|update)\b", re.IGNORECASE)

# Split titles like: "Title — Source", "Title | Source", "Title - Source"
# Support various dashes and optional spaces.
_SPLIT_RE = re.compile(r"\s*[\-\|\u2014\u2013]\s*")  # - | — –
# Keep latin + digits + cyrillic + spaces
_NON_WORD_RE = re.compile(r"[^a-zA-Z0-9а-яА-ЯёЁ\s]+")

# ---- clickbait detection (compat for scoring.py) ----
_CLICKBAIT_PATTERNS = [
    r"\b(shocking|unbelievable|you won'?t believe|what happened next|mind[-\s]?blowing)\b",
    r"\b(outrage|scandal|disaster|panic|horrific|terrifying)\b",
    r"\b(must see|goes viral|blasts|slams|destroys|exposed)\b",
    r"\b(urgent|breaking)\b",
    r"!!!+",
]
_CLICKBAIT_RE = re.compile("|".join(_CLICKBAIT_PATTERNS), re.IGNORECASE)


def has_clickbait(title: str) -> bool:
    """scoring.py expects this function to exist. Simple heuristic."""
    t = (title or "").strip()
    if not t:
        return False
    if _CLICKBAIT_RE.search(t):
        return True
    if t.count("!") >= 2:
        return True
    caps_words = re.findall(r"\b[A-Z]{4,}\b", t)
    if len(caps_words) >= 2:
        return True
    return False


# ---- clustering matching ----
@dataclass
class ClusterMatch:
    cluster_id: int | None
    similarity: float
    method: str
    debug: dict[str, Any]


def normalize_text(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    t = t.replace("\n", " ").replace("\r", " ")
    t = _NON_WORD_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip().lower()
    return t


def normalize_title_for_key(title: str, language: str) -> str:
    """Aggressive normalization for cluster key. Removes prefixes/tails etc."""
    t = (title or "").strip()
    if not t:
        return ""

    t = _PREFIX_RE.sub("", t)

    # Many feeds append source/section after a dash/pipe.
    # We keep only the first chunk if the tail looks like a source/section.
    parts = _SPLIT_RE.split(t)
    if parts:
        # If there are multiple parts, keep the first (the event headline).
        # But do not over-trim very short titles.
        if len(parts) >= 2 and len(parts[0].strip()) >= 12:
            t = parts[0].strip()

    t = _LIVE_WORDS_RE.sub(" ", t)
    t = normalize_text(t)

    if language.lower().startswith("en"):
        toks = [w for w in t.split() if w not in _STOP_EN]
        t = " ".join(toks)

    # cap length so key does not drift with extra context
    t = " ".join(t.split()[:32]).strip()
    return t


def canonical_cluster_key(language: str, normalized_title: str) -> str:
    base = f"{(language or 'en').lower()}::{(normalized_title or '').strip().lower()}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _tokenize(text: str) -> list[str]:
    t = normalize_text(text)
    toks = [x for x in t.split() if len(x) >= 3]
    return toks


def jaccard_similarity(a: str, b: str) -> float:
    A = set(_tokenize(a))
    B = set(_tokenize(b))
    if not A or not B:
        return 0.0
    return len(A & B) / max(1, len(A | B))


def strong_token_overlap(a: str, b: str) -> int:
    """Counts overlap of strong tokens (long words or digits)."""
    ta = _tokenize(a)
    tb = _tokenize(b)
    sa = set([t for t in ta if len(t) >= 5 or t.isdigit()])
    sb = set([t for t in tb if len(t) >= 5 or t.isdigit()])
    return len(sa & sb)


def _digits_set(text: str) -> set[str]:
    return set(re.findall(r"\d{1,4}", text or ""))


def _build_candidates_texts(query: str, candidates: list[tuple[int, str]]) -> tuple[list[str], list[int]]:
    texts = [query]
    ids: list[int] = []
    for cid, txt in candidates:
        ids.append(int(cid))
        texts.append(txt or "")
    return texts, ids


def _combined_tfidf_best_match(
    query: str,
    candidates: list[tuple[int, str]],
) -> tuple[int | None, float, dict[str, Any]]:
    """
    Robust multilingual similarity:
    - word TF-IDF (1–2 grams) captures semantics when wording is close
    - char TF-IDF (3–5) captures near-duplicates, morphology, short titles, non-EN
    """
    if not candidates:
        return None, 0.0, {"reason": "no_candidates"}

    texts, ids = _build_candidates_texts(query, candidates)

    v_word = TfidfVectorizer(ngram_range=(1, 2), min_df=1, max_features=30000)
    Xw = v_word.fit_transform(texts)

    v_char = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=1, max_features=60000)
    Xc = v_char.fit_transform(texts)

    sim_w = cosine_similarity(Xw[0:1], Xw[1:]).flatten()
    sim_c = cosine_similarity(Xc[0:1], Xc[1:]).flatten()

    # Latent Semantic Analysis (cheap "embedding-like" layer)
    # Helps reduce bad merges caused by shared buzzwords.
    lsa_w = None
    try:
        n_samples, n_features = Xw.shape
        k = min(int(os.getenv("CLUSTER_LSA_COMPONENTS", "150")), max(2, n_samples - 1), max(2, n_features - 1))
        if k >= 2:
            svd = TruncatedSVD(n_components=k, random_state=42)
            Z = svd.fit_transform(Xw)
            # L2 normalize
            import numpy as _np
            norms = _np.linalg.norm(Z, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            Z = Z / norms
            lsa_w = (Z[1:] @ Z[0].T)
    except Exception:
        lsa_w = None

    if lsa_w is None:
        sims = 0.65 * sim_w + 0.35 * sim_c
        blend = "0.65*word+0.35*char"
    else:
        w_word = float(os.getenv("CLUSTER_WEIGHT_WORD", "0.55"))
        w_char = float(os.getenv("CLUSTER_WEIGHT_CHAR", "0.25"))
        w_lsa = float(os.getenv("CLUSTER_WEIGHT_LSA", "0.20"))
        w_sum = w_word + w_char + w_lsa
        if w_sum <= 0:
            w_word, w_char, w_lsa, w_sum = 0.55, 0.25, 0.20, 1.0
        w_word, w_char, w_lsa = w_word/w_sum, w_char/w_sum, w_lsa/w_sum
        sims = (w_word * sim_w) + (w_char * sim_c) + (w_lsa * lsa_w)
        blend = f"{w_word:.2f}*word+{w_char:.2f}*char+{w_lsa:.2f}*lsa"

    best_idx = int(sims.argmax())
    best_sim = float(sims[best_idx])
    best_id = int(ids[best_idx])

    top = sorted([(int(ids[i]), float(sims[i])) for i in range(len(sims))], key=lambda x: x[1], reverse=True)[:8]
    return best_id, best_sim, {"top8": top, "blend": blend}


def _dynamic_threshold(text: str, base: float) -> float:
    """Short texts get lower threshold to avoid false splits."""
    toks = _tokenize(text)
    if len(toks) <= 6:
        return max(0.22, base - 0.10)
    if len(toks) <= 10:
        return max(0.26, base - 0.06)
    return float(base)


# ---- gates (before merge) ----
_CAP_SEQ_RE = re.compile(r"\b(?:[A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+){0,3}|[A-ZА-ЯЁ]{2,}(?:\s+[A-ZА-ЯЁ]{2,}){0,2})\b")

_COMMON_NOISE = {
    "the","and","for","with","from","over","into","after","before","says","said",
    "this","that","will","new","news","live","update","updates","breaking","top",
    "what","why","how","who","where","when","in","on","at","to","of","a","an",
}


def extract_entities(text: str) -> set[str]:
    """Cheap offline 'NER-ish' extractor to prevent bad merges."""
    if not text:
        return set()
    ents: set[str] = set()
    for m in _CAP_SEQ_RE.finditer(text):
        chunk = m.group(0).strip()
        words = [w.strip(".") for w in chunk.split()]
        if len(words) == 1 and len(words[0]) < 4:
            continue
        norm = " ".join(words).lower()
        if norm in _COMMON_NOISE:
            continue
        ents.add(norm)
        for w in words:
            lw = w.lower()
            if lw not in _COMMON_NOISE and len(lw) >= 3:
                ents.add(lw)
    # Limit size
    if len(ents) > 60:
        ents = set(sorted(ents, key=lambda x: (-len(x), x))[:60])
    return ents


def _parse_iso_dt(s: str | None) -> Optional[datetime]:
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


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a.intersection(b))
    union = len(a.union(b))
    return inter / union if union else 0.0


def match_cluster(
    article_text: str,
    candidates: list[tuple[int, str]],
    similarity_threshold: float = 0.35,
) -> ClusterMatch:
    """
    Stage 1: blended TF-IDF (word + char) with dynamic threshold
    Stage 2: Jaccard + strong overlap + digits agreement fallback
    """
    txt = (article_text or "").strip()
    if not txt:
        return ClusterMatch(cluster_id=None, similarity=0.0, method="empty", debug={})

    txt_norm = normalize_text(txt)
    thr = _dynamic_threshold(txt_norm, similarity_threshold)

    cid, sim, dbg = _combined_tfidf_best_match(txt_norm, candidates)
    if cid is not None and sim >= thr:
        # Extra safety check: TF-IDF can over-match on a single shared entity (e.g. "Trump").
        # We require at least some *strong* token overlap or a higher similarity.


        cand_text = next((t for (i, t) in candidates if int(i) == int(cid)), "")
        c_norm = normalize_text(cand_text)
        ov = strong_token_overlap(txt_norm, c_norm)
        j = jaccard_similarity(txt_norm, c_norm)

        # Entities are a strong discriminant (people/places/orgs). We extract them early so we can
        # apply stricter "no-signal" gates without relying on an LLM arbiter being available.
        entity_q = set(extract_entities(txt))
        entity_c = set(extract_entities(cand_text))
        ent_ov = len(entity_q & entity_c)

        # If overlap is weak, only accept a meaningfully higher similarity.
        # (We previously used a lower floor here and observed occasional cross-topic merges on short UK/US headlines.)
        if ov < 2 and j < 0.16:
            strict = max(0.72, thr + 0.22)
            if sim < strict:
                return ClusterMatch(
                    cluster_id=None,
                    similarity=sim,
                    method="tfidf_rejected_low_overlap",
                    debug={**dbg, "threshold": thr, "strict": strict, "ov": ov, "j": j, "ent_ov": ent_ov},
                )

        # Extra safety: when there is *no* lexical/entity signal (no strong-token overlap,
        # very low Jaccard, no entity overlap), do not merge unless the texts are near-identical.
        if ov == 0 and j < 0.12 and ent_ov == 0:
            strict2 = max(0.88, thr + 0.35)
            if sim < strict2:
                return ClusterMatch(
                    cluster_id=None,
                    similarity=sim,
                    method="tfidf_rejected_no_signal",
                    debug={**dbg, "threshold": thr, "strict2": strict2, "ov": ov, "j": j, "ent_ov": ent_ov},
                )

        # Borderline arbiter: when TF-IDF says "match" but evidence is weak,
        # ask an LLM (optional) to confirm same-event vs same-topic.
        # This avoids cases like "Trump/Grammys" being merged with "Oil prices" just because of sidebar/related terms.
        need_llm = False

        # Hard gate: if both sides have clear entities but none overlap, they are almost surely different events.
        # This prevents catastrophic merges (different people/places) especially in non-English feeds.
        if ent_ov == 0 and len(entity_q) >= 2 and len(entity_c) >= 2:
            return ClusterMatch(
                cluster_id=None,
                similarity=sim,
                method="entity_gate_rejected",
                debug={**dbg, "threshold": thr, "ov": ov, "j": j, "ent_q": sorted(list(entity_q))[:20], "ent_c": sorted(list(entity_c))[:20]},
            )

        # Cheap deterministic reject for very weak borderline matches.
        low_signal_floor = max(_LLM_MIN_BORDERLINE_SIM, thr + 0.12)
        if sim < low_signal_floor and (ov < 3 or j < 0.18 or ent_ov == 0):
            return ClusterMatch(
                cluster_id=None,
                similarity=sim,
                method="borderline_low_signal_rejected",
                debug={**dbg, "threshold": thr, "ov": ov, "j": j, "ent_ov": ent_ov, "low_signal_floor": low_signal_floor},
            )

        # Only trigger for the grey zone: similarity is reasonably close, but lexical/entity evidence is still weak.
        if low_signal_floor <= sim <= max(_LLM_MAX_BORDERLINE_SIM, thr + 0.18) and (ov < 4 or j < 0.22 or ent_ov == 0):
            need_llm = True

        if need_llm:
            # Avoid noisy console spam; enable with CLUSTER_LLM_VERBOSE=1
            if os.getenv("CLUSTER_LLM_VERBOSE", "0") == "1":
                logger.info("[LLM] ARBITER TRIGGERED sim=%.3f thr=%.3f ov=%d j=%.3f ent_ov=%d", sim, thr, ov, j, ent_ov)
                logger.info("[LLM] A=%s", txt_norm[:160])
                logger.info("[LLM] B=%s", c_norm[:160])

            same, conf, rat = llm_same_event(txt_norm, c_norm)

            if os.getenv("CLUSTER_LLM_VERBOSE", "0") == "1":
                logger.info("[LLM] RESULT same=%s conf=%.2f reason=%s", same, conf, rat)

            if same is False:
                return ClusterMatch(
                    cluster_id=None,
                    similarity=sim,
                    method="llm_rejected",
                    debug={**dbg, "threshold": thr, "ov": ov, "j": j, "ent_ov": ent_ov, "llm_conf": conf, "llm_reason": rat},
                )
            # Safety rule: when an arbiter was required but unavailable, do not auto-merge.
            if same is True:
                dbg = {**dbg, "llm_conf": conf, "llm_reason": rat, "ent_ov": ent_ov}
            else:
                return ClusterMatch(
                    cluster_id=None,
                    similarity=sim,
                    method="llm_unavailable_rejected",
                    debug={**dbg, "threshold": thr, "ov": ov, "j": j, "ent_ov": ent_ov, "llm_reason": rat},
                )

        return ClusterMatch(cluster_id=cid, similarity=sim, method="tfidf_blend", debug={**dbg, "threshold": thr, "ov": ov, "j": j})

    best_cid = None
    best_j = 0.0
    best_ov = 0
    best_digits = 0
    checked = 0
    q_digits = _digits_set(txt_norm)

    for cand_id, cand_text in candidates[:350]:
        checked += 1
        c_norm = normalize_text(cand_text)
        j = jaccard_similarity(txt_norm, c_norm)
        ov = strong_token_overlap(txt_norm, c_norm)
        d = len(q_digits & _digits_set(c_norm)) if q_digits else 0

        ok = (j >= 0.20) or (j >= 0.16 and ov >= 3) or (ov >= 4) or (d >= 2 and ov >= 2)
        if ok:
            score = j + 0.03 * ov + 0.04 * d
            if score > best_j + 0.03 * best_ov + 0.04 * best_digits:
                best_j = j
                best_ov = ov
                best_digits = d
                best_cid = int(cand_id)

    if best_cid is not None:
        return ClusterMatch(
            cluster_id=best_cid,
            similarity=float(best_j),
            method="overlap",
            debug={
                "checked": checked,
                "best_jaccard": best_j,
                "best_overlap": best_ov,
                "best_digits": best_digits,
                "tfidf_best": {"id": cid, "sim": sim, **dbg, "threshold": thr},
            },
        )

    return ClusterMatch(
        cluster_id=None,
        similarity=float(sim),
        method="no_match",
        debug={"tfidf": {"id": cid, "sim": sim, **dbg, "threshold": thr}, "checked": checked},
    )
