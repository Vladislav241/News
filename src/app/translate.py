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
  created_at TEXT DEFAULT (datetime('now')),
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
        "INSERT OR REPLACE INTO translate_cache_v2(lang, sha1, original, translated) VALUES(?,?,?,?)",
        (lang, key, text, translated),
    )

    # best-effort: also write v1 (doesn't hurt older code paths)
    db._exec(
        "INSERT OR REPLACE INTO translate_cache(scope, scope_id, field, lang, sha1, original, translated) VALUES(?,?,?,?,?,?,?)",
        (scope, scope_id, field, lang, key, text, translated),
    )

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
    lang = _norm_ui_lang(ui_lang)
    # NOTE: translate even for English UI (see translate_text_cached).

    tasks: List[Tuple[str, str, str, str]] = []  # (scope, scope_id, field, text)

    for it in items or []:
    # Skip translation if item already matches UI language
        item_lang = (it.get("language") or "").strip().lower()
        if item_lang and item_lang == lang:
            continue

        cid = str(it.get("cluster_id") or it.get("id") or it.get("event_id") or "")
        if not cid:
            continue


        title = (it.get("title") or "").strip()
        if title:
            tasks.append(("cluster", cid, "title", title))

        summary = (it.get("summary") or "").strip()
        st = str(it.get("summary_status") or "").lower().strip()
        if summary and st not in ("locked", "skipped"):
            tasks.append(("cluster", cid, "summary", summary))

        # summary facts
        facts = it.get("summary_facts") or []
        if isinstance(facts, list):
            for idx, f in enumerate(facts):
                if isinstance(f, str) and f.strip():
                    tasks.append(("cluster", f"{cid}:fact:{idx}", "fact", f.strip()))

        # summary diffs
        diffs = it.get("summary_diffs") or []
        if isinstance(diffs, list):
            for idx, d in enumerate(diffs):
                txt = (d.get("difference") or "").strip()
                if txt:
                    tasks.append(("cluster", f"{cid}:diff:{idx}", "diff", txt))


        srcs = it.get("sources") or []
        if isinstance(srcs, list):
            for idx, s in enumerate(srcs[:30]):
                if not isinstance(s, dict):
                    continue
                stitle = (s.get("title") or "").strip()
                if stitle:
                    tasks.append(("source", f"{cid}:{idx}", "title", stitle))

    need_texts: List[str] = []
    need_meta: List[Tuple[str, str, str, str]] = []
    resolved: Dict[Tuple[str, str, str, str], str] = {}

    for scope, scope_id, field, text in tasks:
        cached = get_cached_translation(scope, scope_id, field, lang, text)
        if cached is None:
            need_texts.append(text)
            need_meta.append((scope, scope_id, field, text))
        else:
            resolved[(scope, scope_id, field, text)] = cached

    if need_texts:
        translated_list = await _deepl_translate_texts(need_texts, _deepl_target(lang))
        for meta, tr in zip(need_meta, translated_list):
            scope, scope_id, field, text = meta
            resolved[meta] = tr

            # НЕ кэшируем, если перевод равен оригиналу
            if tr and tr.strip() and tr.strip() != text:
                put_cached_translation(scope, scope_id, field, lang, text, tr)


    out_items: List[Dict[str, Any]] = []

    for it in items or []:
        cid = str(it.get("cluster_id") or it.get("id") or it.get("event_id") or "")
        if not cid:
            out_items.append(it)
            continue

        new_it = dict(it)

        # title
        title = (new_it.get("title") or "").strip()
        if title:
            new_it["title"] = resolved.get(("cluster", cid, "title", title), title)

        # summary
        summary = (new_it.get("summary") or "").strip()
        st = str(new_it.get("summary_status") or "").lower().strip()
        if summary and st not in ("locked", "skipped"):
            new_it["summary"] = resolved.get(("cluster", cid, "summary", summary), summary)

        # ✅ APPLY TRANSLATED FACTS (ВНУТРИ ЦИКЛА)
        facts = new_it.get("summary_facts")
        if isinstance(facts, list):
            new_it["summary_facts"] = [
                resolved.get(("cluster", f"{cid}:fact:{i}", "fact", f), f)
                for i, f in enumerate(facts)
            ]

        # ✅ APPLY TRANSLATED DIFFS (ВНУТРИ ЦИКЛА)
        diffs = new_it.get("summary_diffs")
        if isinstance(diffs, list):
            new_diffs = []
            for i, d in enumerate(diffs):
                nd = dict(d)
                txt = (d.get("difference") or "").strip()
                if txt:
                    nd["difference"] = resolved.get(
                        ("cluster", f"{cid}:diff:{i}", "diff", txt),
                        txt
                    )
                new_diffs.append(nd)
            new_it["summary_diffs"] = new_diffs

        # sources
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
                    ns["title"] = resolved.get(
                        ("source", f"{cid}:{idx}", "title", stitle),
                        stitle
                    )
                new_srcs.append(ns)
            new_it["sources"] = new_srcs

        out_items.append(new_it)


    return out_items
