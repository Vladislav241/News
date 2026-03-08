from __future__ import annotations

import hashlib
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx
import anyio
from .db import db

# =========================
# DeepL-based translation
# =========================
# Set in your environment:
#   DEEPL_API_KEY=...
# Optional:
#   DEEPL_API_URL=https://api-free.deepl.com   (or https://api.deepl.com)
#
# If DEEPL_API_KEY is missing, translation becomes a no-op (original text is returned).

DEEPL_API_KEY = (os.getenv("DEEPL_API_KEY") or "").strip()
DEEPL_API_URL = (os.getenv("DEEPL_API_URL") or "").strip()

def _default_deepl_url(key: str) -> str:
    # DeepL Free keys usually end with ':fx'
    if key and key.endswith(":fx"):
        return "https://api-free.deepl.com"
    return "https://api.deepl.com"

if not DEEPL_API_URL:
    DEEPL_API_URL = _default_deepl_url(DEEPL_API_KEY)


# =========================
# Safety / budget controls
# =========================
# Goal: prevent burning DeepL quota on every feed refresh.
#
# - Circuit breaker: when quota is exceeded (HTTP 456), we disable DeepL for a cooldown.
# - Budget: cap how many NEW texts we translate per API response (everything else stays original).
# - Scope: by default we translate only cluster-level fields (title + summary). Source titles / facts
#   are expensive; they can be enabled via env vars.
#
# These are environment-tunable so you can tweak without code changes on Render.

DEEPL_COOLDOWN_SECONDS = int(os.getenv("DEEPL_COOLDOWN_SECONDS") or "21600")  # 6h default
MAX_DEEPL_TEXTS_PER_RESPONSE = int(os.getenv("MAX_DEEPL_TEXTS_PER_RESPONSE") or "140")

TRANSLATE_INCLUDE_SOURCES = (os.getenv("TRANSLATE_INCLUDE_SOURCES") or "").strip() in ("1", "true", "yes")
TRANSLATE_INCLUDE_FACTS = (os.getenv("TRANSLATE_INCLUDE_FACTS") or "1").strip().lower() in ("1", "true", "yes")
TRANSLATE_INCLUDE_DIFFS = (os.getenv("TRANSLATE_INCLUDE_DIFFS") or "1").strip().lower() in ("1", "true", "yes")
TRANSLATE_INCLUDE_UNCERTAINTIES = (os.getenv("TRANSLATE_INCLUDE_UNCERTAINTIES") or "1").strip().lower() in ("1", "true", "yes")

# In-memory circuit breaker. (Works per-process; good enough to stop stampedes.)
_DEEPL_DISABLED_UNTIL = 0.0
_DEEPL_LOCK = anyio.Lock()

def _now() -> float:
    import time as _time
    return _time.time()

def _deepl_is_enabled() -> bool:
    return bool(DEEPL_API_KEY) and _now() >= _DEEPL_DISABLED_UNTIL

async def _deepl_disable_for_cooldown() -> None:
    global _DEEPL_DISABLED_UNTIL
    async with _DEEPL_LOCK:
        # extend cooldown; don't shorten if already disabled
        _DEEPL_DISABLED_UNTIL = max(_DEEPL_DISABLED_UNTIL, _now() + float(DEEPL_COOLDOWN_SECONDS))


def _deepl_disable_for_cooldown_sync() -> None:
    global _DEEPL_DISABLED_UNTIL
    # Best-effort; race conditions here are fine.
    _DEEPL_DISABLED_UNTIL = max(_DEEPL_DISABLED_UNTIL, _now() + float(DEEPL_COOLDOWN_SECONDS))

def _looks_cyrillic(s: str) -> bool:
    # Quick heuristic for RU/UK content
    if not s:
        return False
    cyr = sum(1 for ch in s if "\u0400" <= ch <= "\u04FF" or "\u0500" <= ch <= "\u052F")
    letters = sum(1 for ch in s if ch.isalpha())
    if letters == 0:
        return False
    return (cyr / letters) >= 0.25

def _should_translate_text(ui_lang: str, item_lang: str | None, text: str) -> bool:
    """Decide whether translating this text is worth it.

    We strongly avoid translating when language metadata is missing, because that's how quota gets burned.
    We still translate when a simple script heuristic strongly suggests it's needed.
    """
    lang = _norm_ui_lang(ui_lang)
    il = (item_lang or "").strip().lower()
    t = (text or "").strip()
    if not t:
        return False

    # If we KNOW item language equals UI language -> never translate
    if il and il.split("-")[0] == lang:
        return False

    # If item language is known and different -> translate
    if il:
        return True

    # Unknown item language: only translate when the script clearly mismatches the UI.
    if lang == "en":
        return _looks_cyrillic(t)
    if lang in ("ru", "uk"):
        # Translate latin-heavy texts into Cyrillic UIs
        return not _looks_cyrillic(t)
    # For DE/FR and other Latin-script UIs we still want English content translated
    # even when source language metadata is missing. Keep a small guard so we do not
    # waste quota on very short labels / acronyms.
    latin_letters = sum(1 for ch in t if ("a" <= ch.lower() <= "z") or ("\u00c0" <= ch <= "\u024f"))
    if lang in ("de", "fr"):
        return _looks_cyrillic(t) or latin_letters >= 12
    return _looks_cyrillic(t)

# DeepL expects uppercase language codes; Ukrainian is "UK"
_LANG_MAP = {
    "en": "EN",
    "de": "DE",
    "fr": "FR",
    "ru": "RU",
    "uk": "UK",
    "ua": "UK",
}

def _norm_ui_lang(lang: str) -> str:
    raw = (lang or "").strip().lower()
    if not raw:
        return "en"
    base = raw.split("-")[0]
    if base == "ua":
        base = "uk"
    return base if base in _LANG_MAP else "en"

def _deepl_target(lang: str) -> str:
    return _LANG_MAP.get(_norm_ui_lang(lang), "EN")

# =========================
# SQLite cache (v2)
# =========================
# IMPORTANT:
# We intentionally cache by (lang, sha1(text)) only.
# This means ONE DeepL call can serve every user/device, across every scope/item.
#
# We keep a legacy v1 reader for older DB files so existing installs continue to work.

CREATE_TABLE_V2_SQL = """
CREATE TABLE IF NOT EXISTS translate_cache_v2 (
  lang TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  original TEXT NOT NULL,
  translated TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lang, sha1)
);
"""

CREATE_TABLE_V1_SQL = """
CREATE TABLE IF NOT EXISTS translate_cache (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  field TEXT NOT NULL,
  lang TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  original TEXT NOT NULL,
  translated TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_id, field, lang, sha1)
);
"""

def _ensure_table() -> None:
    # NOTE: our Database wrapper exposes internal helpers `_exec/_fetchone`.
    # translate.py previously called `db.execute/db.fetchone` (older API),
    # which raises AttributeError and makes translation silently fail-open.
    # v2 is the primary cache
    db._exec(CREATE_TABLE_V2_SQL)
    # v1 is kept for backward compatibility (older DBs)
    db._exec(CREATE_TABLE_V1_SQL)

def _sha1(s: str) -> str:
    return hashlib.sha1((s or "").encode("utf-8")).hexdigest()

def get_cached_translation(scope: str, scope_id: str, field: str, lang: str, text: str) -> Optional[str]:
    _ensure_table()
    key = _sha1(text)

    # v2 lookup (global cache)
    row2 = db._fetchone(
        "SELECT translated FROM translate_cache_v2 WHERE lang=? AND sha1=?",
        (lang, key),
    )
    if row2:
        return row2["translated"]

    # v1 fallback (scoped cache)
    row1 = db._fetchone(
        "SELECT translated FROM translate_cache WHERE scope=? AND scope_id=? AND field=? AND lang=? AND sha1=?",
        (scope, scope_id, field, lang, key),
    )
    return row1["translated"] if row1 else None

def put_cached_translation(scope: str, scope_id: str, field: str, lang: str, text: str, translated: str) -> None:
    _ensure_table()
    key = _sha1(text)
    # v2 insert (global)
    db._exec(
        "INSERT INTO translate_cache_v2(lang, sha1, original, translated) VALUES(?,?,?,?) "
        "ON CONFLICT (lang, sha1) DO UPDATE SET original=EXCLUDED.original, translated=EXCLUDED.translated, created_at=now()",
        (lang, key, text, translated),
    ),

    # best-effort: also write v1 (doesn't hurt older code paths)
    db._exec(
        "INSERT INTO translate_cache(scope, scope_id, field, lang, sha1, original, translated) VALUES(?,?,?,?,?,?,?) "
        "ON CONFLICT (scope, scope_id, field, lang, sha1) DO UPDATE SET original=EXCLUDED.original, translated=EXCLUDED.translated, created_at=now()",
        (scope, scope_id, field, lang, key, text, translated),
    ),

# =========================
# DeepL client helpers
# =========================
from urllib.parse import urlencode

def _deepl_translate_texts_sync(texts: List[str], target_lang: str) -> List[str]:
    # 1) sanitize inputs -> always List[str]
    clean_texts: List[str] = []
    for t in (texts or []):
        if t is None:
            continue
        if isinstance(t, tuple):
            t = " ".join(str(x) for x in t)
        elif not isinstance(t, str):
            t = str(t)
        t = t.strip()
        if t:
            clean_texts.append(t)

    texts = clean_texts

    # Circuit breaker: if quota was exceeded recently, skip calling DeepL.
    if not _deepl_is_enabled():
        return texts

    if not DEEPL_API_KEY:
        return texts
    if not texts:
        return []

    headers = {"Authorization": f"DeepL-Auth-Key {DEEPL_API_KEY}"}
    MAX_BATCH = 50
    out: List[str] = []

    with httpx.Client(timeout=25.0) as client:
        for i in range(0, len(texts), MAX_BATCH):
            batch = texts[i:i + MAX_BATCH]

            # 2) build x-www-form-urlencoded manually (doseq=True for repeated "text")
            form = {
                "target_lang": str(target_lang),
                "preserve_formatting": "1",
                "text": [str(x) for x in batch],  # гарантируем строки
            }
            body = urlencode(form, doseq=True)

            try:
                r = client.post(
                    f"{DEEPL_API_URL}/v2/translate",
                    content=body,
                    headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
                )

                if r.status_code != 200:
                    # DeepL returns 456 on quota exceeded. Stop further calls for a while.
                    if r.status_code == 456 and ("Quota exceeded" in r.text or "quota" in r.text.lower()):
                        _deepl_disable_for_cooldown_sync()
                    print("[DEEPL] non-200:", r.status_code, r.text[:300])
                    out.extend(batch)
                    continue

                j = r.json()
                out.extend([x.get("text", "") for x in j.get("translations", [])])

            except Exception as e:
                print("[DEEPL] exception:", repr(e))
                out.extend(batch)

    if len(out) != len(texts):
        out = (out + texts)[:len(texts)]
    return out


async def _deepl_translate_texts(texts: List[str], target_lang: str) -> List[str]:
    return await anyio.to_thread.run_sync(_deepl_translate_texts_sync, texts, target_lang)

# =========================
# Public API used by routers
# =========================
async def translate_text_cached(scope: str, scope_id: str, field: str, ui_lang: str, text: str) -> str:
    lang = _norm_ui_lang(ui_lang)
    # NOTE: we translate even for English UI.
    # Otherwise Russian/German/etc sources will stay in their original language.

    src = (text or "").strip()
    if not src:
        return text

    cached = get_cached_translation(scope, str(scope_id), field, lang, src)
    if cached is not None:
        return cached

    translated = (await _deepl_translate_texts([src], _deepl_target(lang)))[0]

    # НЕ кэшируем, если DeepL вернул то же самое (скорее всего был фейл/лимит/ошибка)
    if translated and translated.strip() and translated.strip() != src:
        put_cached_translation(scope, str(scope_id), field, lang, src, translated)

    return translated



async def translate_feed_items(items: List[Dict[str, Any]], ui_lang: str) -> List[Dict[str, Any]]:
    """Translate feed items in a quota-safe way.

    Design goals:
      - Translate only cluster-level fields by default (title + summary).
      - Use cache first; translate only cache-misses.
      - Cap the number of NEW translations per response (budget).
      - Fail-open when DeepL quota is exceeded (circuit breaker).
    """
    lang = _norm_ui_lang(ui_lang)

    if not items:
        return items

    # If DeepL is disabled (quota exceeded) -> fail-open.
    if not _deepl_is_enabled():
        return items

    tasks: List[Tuple[str, str, str, str, Optional[str]]] = []  # (scope, scope_id, field, text, item_lang)

    def _infer_item_lang(it: Dict[str, Any]) -> Optional[str]:
        il = (it.get("language") or "").strip().lower()
        if il:
            return il
        srcs = it.get("sources") or []
        if isinstance(srcs, list):
            for s in srcs[:5]:
                if isinstance(s, dict):
                    sl = (s.get("language") or "").strip().lower()
                    if sl:
                        return sl
        return None

    for it in items or []:
        cid = str(it.get("cluster_id") or it.get("id") or it.get("event_id") or "")
        if not cid:
            continue

        item_lang = _infer_item_lang(it)

        title = (it.get("title") or "").strip()
        if title and _should_translate_text(lang, item_lang, title):
            tasks.append(("cluster", cid, "title", title, item_lang))

        summary = (it.get("summary") or "").strip()
        st = str(it.get("summary_status") or "").lower().strip()
        if summary and st not in ("locked", "skipped") and _should_translate_text(lang, item_lang, summary):
            tasks.append(("cluster", cid, "summary", summary, item_lang))

        if TRANSLATE_INCLUDE_FACTS:
            facts = it.get("summary_facts") or []
            if isinstance(facts, list):
                for idx, f in enumerate(facts):
                    if isinstance(f, str):
                        ftxt = f.strip()
                        if ftxt and _should_translate_text(lang, item_lang, ftxt):
                            tasks.append(("cluster", f"{cid}:fact:{idx}", "fact", ftxt, item_lang))

        if TRANSLATE_INCLUDE_DIFFS:
            diffs = it.get("summary_diffs") or []
            if isinstance(diffs, list):
                for idx, d in enumerate(diffs):
                    if isinstance(d, dict):
                        txt = (d.get("difference") or "").strip()
                        if txt and _should_translate_text(lang, item_lang, txt):
                            tasks.append(("cluster", f"{cid}:diff:{idx}", "diff", txt, item_lang))

        if TRANSLATE_INCLUDE_UNCERTAINTIES:
            uncertainties = it.get("summary_uncertainties") or []
            if isinstance(uncertainties, list):
                for idx, u in enumerate(uncertainties):
                    if isinstance(u, str):
                        utxt = u.strip()
                        if utxt and _should_translate_text(lang, item_lang, utxt):
                            tasks.append(("cluster", f"{cid}:uncertainty:{idx}", "uncertainty", utxt, item_lang))

        if TRANSLATE_INCLUDE_SOURCES:
            srcs = it.get("sources") or []
            if isinstance(srcs, list):
                for idx, s in enumerate(srcs[:20]):
                    if not isinstance(s, dict):
                        continue
                    stitle = (s.get("title") or "").strip()
                    if stitle and _should_translate_text(lang, (s.get("language") or item_lang), stitle):
                        tasks.append(("source", f"{cid}:{idx}", "title", stitle, (s.get("language") or item_lang)))

    # De-dup tasks by exact key to reduce work
    seen = set()
    uniq_tasks = []
    for t in tasks:
        key = (t[0], t[1], t[2], t[3])
        if key in seen:
            continue
        seen.add(key)
        uniq_tasks.append(t)
    tasks = uniq_tasks

    need_texts: List[str] = []
    need_meta: List[Tuple[str, str, str, str]] = []
    resolved: Dict[Tuple[str, str, str, str], str] = {}

    for scope, scope_id, field, text, _il in tasks:
        cached = get_cached_translation(scope, scope_id, field, lang, text)
        if cached is None:
            need_texts.append(text)
            need_meta.append((scope, scope_id, field, text))
        else:
            resolved[(scope, scope_id, field, text)] = cached

    # Budget: only translate up to MAX_DEEPL_TEXTS_PER_RESPONSE cache-misses per response
    if need_texts:
        budget = max(0, int(MAX_DEEPL_TEXTS_PER_RESPONSE))
        todo_texts = need_texts[:budget] if budget else []
        todo_meta = need_meta[:budget] if budget else []

        # Anything beyond budget stays original (and is NOT cached as "translated")
        for meta in need_meta[budget:]:
            scope, scope_id, field, text = meta
            resolved[(scope, scope_id, field, text)] = text

        if todo_texts:
            translated_list = await _deepl_translate_texts(todo_texts, _deepl_target(lang))
            for meta, tr in zip(todo_meta, translated_list):
                scope, scope_id, field, text = meta
                resolved[(scope, scope_id, field, text)] = tr

                # Cache only successful translations (not identical)
                if tr and tr.strip() and tr.strip() != text:
                    put_cached_translation(scope, scope_id, field, lang, text, tr)

    out_items: List[Dict[str, Any]] = []

    for it in items or []:
        cid = str(it.get("cluster_id") or it.get("id") or it.get("event_id") or "")
        if not cid:
            out_items.append(it)
            continue

        new_it = dict(it)

        title = (new_it.get("title") or "").strip()
        if title:
            new_it["title"] = resolved.get(("cluster", cid, "title", title), title)

        summary = (new_it.get("summary") or "").strip()
        st = str(new_it.get("summary_status") or "").lower().strip()
        if summary and st not in ("locked", "skipped"):
            new_it["summary"] = resolved.get(("cluster", cid, "summary", summary), summary)

        if TRANSLATE_INCLUDE_FACTS:
            facts = new_it.get("summary_facts")
            if isinstance(facts, list):
                new_it["summary_facts"] = [
                    resolved.get(("cluster", f"{cid}:fact:{i}", "fact", (f or "").strip()), f)
                    for i, f in enumerate(facts)
                ]

        if TRANSLATE_INCLUDE_DIFFS:
            diffs = new_it.get("summary_diffs")
            if isinstance(diffs, list):
                new_diffs = []
                for i, d in enumerate(diffs):
                    if not isinstance(d, dict):
                        new_diffs.append(d)
                        continue
                    nd = dict(d)
                    txt = (d.get("difference") or "").strip()
                    if txt:
                        nd["difference"] = resolved.get(("cluster", f"{cid}:diff:{i}", "diff", txt), txt)
                    new_diffs.append(nd)
                new_it["summary_diffs"] = new_diffs

        if TRANSLATE_INCLUDE_UNCERTAINTIES:
            uncertainties = new_it.get("summary_uncertainties")
            if isinstance(uncertainties, list):
                new_it["summary_uncertainties"] = [
                    resolved.get(("cluster", f"{cid}:uncertainty:{i}", "uncertainty", (u or "").strip()), u)
                    for i, u in enumerate(uncertainties)
                ]

        if TRANSLATE_INCLUDE_SOURCES:
            srcs = new_it.get("sources")
            if isinstance(srcs, list):
                new_srcs = []
                for idx, s in enumerate(srcs):
                    if not isinstance(s, dict):
                        new_srcs.append(s)
                        continue
                    ns = dict(s)
                    stitle = (ns.get("title") or "").strip()
                    if stitle:
                        ns["title"] = resolved.get(("source", f"{cid}:{idx}", "title", stitle), stitle)
                    new_srcs.append(ns)
                new_it["sources"] = new_srcs

        out_items.append(new_it)

    return out_items
