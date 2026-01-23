# src/app/clustering.py
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# ---- stopwords / normalization ----
# NOTE: стоп-слова чистим только для EN.
# Для RU/DE и прочих языков без нормального NLP лучше работает char n-gram TF-IDF.
_STOP_EN = {
    "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "from",
    "with", "as", "by", "is", "are", "was", "were", "be", "been", "it", "its",
    "this", "that", "these", "those", "after", "before", "over", "under", "into",
    "will", "says", "say", "said", "new", "live", "updates", "update", "breaking",
}

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

    sims = 0.65 * sim_w + 0.35 * sim_c

    best_idx = int(sims.argmax())
    best_sim = float(sims[best_idx])
    best_id = int(ids[best_idx])

    top = sorted([(int(ids[i]), float(sims[i])) for i in range(len(sims))], key=lambda x: x[1], reverse=True)[:8]
    return best_id, best_sim, {"top8": top, "blend": "0.65*word+0.35*char"}


def _dynamic_threshold(text: str, base: float) -> float:
    """Short texts get lower threshold to avoid false splits."""
    toks = _tokenize(text)
    if len(toks) <= 6:
        return max(0.22, base - 0.10)
    if len(toks) <= 10:
        return max(0.26, base - 0.06)
    return float(base)


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
        return ClusterMatch(cluster_id=cid, similarity=sim, method="tfidf_blend", debug={**dbg, "threshold": thr})

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
