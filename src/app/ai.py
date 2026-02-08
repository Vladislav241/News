from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional, Tuple

logger = logging.getLogger("news.ai")

# Human-readable language names for prompts
_LANG_LABELS = {
    "en": "English",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "uk": "Ukrainian",
    # tolerate "ua" coming from UI
    "ua": "Ukrainian",
}


def _norm_lang(code: str) -> str:
    """
    Normalize language codes:
    - accepts: en, de, fr, ru, uk (and ua alias)
    - drops region: en-US -> en
    - unknown -> en
    """
    c = (code or "en").strip().lower()
    c = c.split("-")[0]
    if c == "ua":
        c = "uk"
    if c not in {"en", "de", "fr", "ru", "uk"}:
        c = "en"
    return c


def verify_same_story(
    a_title: str,
    a_desc: str,
    b_title: str,
    b_desc: str,
    model: str = "gpt-4o-mini",
) -> bool:
    """
    Binary gate: check if two headlines/descriptions refer to the same event.
    Intentionally short to keep token cost low.
    If OPENAI_API_KEY is not set, returns True (so the pipeline still works offline).
    """
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return True

    # Import lazily so local/offline runs don't fail import-time.
    from openai import OpenAI

    def clip(s: str, n: int = 380) -> str:
        s = (s or "").strip().replace("\n", " ")
        return s[:n]

    prompt = (
        "Are these two news items about the SAME real-world event?\n"
        "Answer with only one letter: Y or N.\n\n"
        f"A title: {clip(a_title)}\n"
        f"A desc: {clip(a_desc)}\n\n"
        f"B title: {clip(b_title)}\n"
        f"B desc: {clip(b_desc)}\n"
    )

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a strict news deduplication classifier."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=1,
        )
        txt = (resp.choices[0].message.content or "").strip().upper()
        return txt.startswith("Y")
    except Exception:
        logger.exception("verify_same_story failed; allowing match")
        return True


def _unwrap_fenced(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", t).strip()
        t = re.sub(r"\s*```$", "", t).strip()
    return t


def _parse_json(text: str) -> Optional[dict[str, Any]]:
    t = _unwrap_fenced(text or "")
    if not t:
        return None
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _validate(obj: dict[str, Any], sources: list[dict[str, Any]]) -> bool:
    """
    Validate structure and enforce that diffs cite >=2 concrete known sources.
    Also blocks vague wording in multiple languages.
    """
    if not isinstance(obj.get("brief"), str) or not obj["brief"].strip():
        return False
    if not isinstance(obj.get("key_facts"), list) or not obj["key_facts"]:
        return False
    if not isinstance(obj.get("diffs"), list) or not obj["diffs"]:
        return False
    if "uncertainties" in obj and not isinstance(obj["uncertainties"], list):
        return False

    known = {(s.get("source_name") or "").strip() for s in (sources or [])}
    known = {x for x in known if x}

    def ok_src_list(lst: Any) -> bool:
        if not isinstance(lst, list):
            return False
        ss = [str(x).strip() for x in lst if str(x).strip()]
        if len(ss) < 2:
            return False
        # Must be from known list; check first 2 (that's what we require)
        return all((x in known) for x in ss[:2])

    # block vague wording (RU/EN/DE/FR/UK)
    vague_re = re.compile(
        r"\b("
        r"некоторые|другие|часть\s+источников|многие\s+источники|ряд\s+источников|"
        r"some\s+sources|other\s+sources|several\s+sources|many\s+sources|"
        r"einige\s+quellen|andere\s+quellen|mehrere\s+quellen|"
        r"certaines\s+sources|d'autres\s+sources|plusieurs\s+sources|"
        r"деякі\s+джерела|інші\s+джерела|кілька\s+джерел"
        r")\b",
        re.IGNORECASE,
    )

    for d in (obj.get("diffs") or [])[:5]:
        if not isinstance(d, dict):
            return False
        if not ok_src_list(d.get("sources")):
            return False
        if not isinstance(d.get("difference"), str) or not d["difference"].strip():
            return False
        if vague_re.search(d["difference"]):
            return False

    return True


def summarize_cluster(
    cluster_title: str,
    sources: list[dict[str, Any]],
    lang: str = "en",
    model: str = "gpt-4o-mini",
) -> Tuple[Optional[str], Optional[str], str, Optional[str]]:
    """
    Returns: (brief|None, summary_json|None, status, raw_text|None)

    summary_json is a strict JSON string:
    {
      "brief": "...",
      "key_facts": ["..."],
      "diffs": [{"sources":["A","B"],"difference":"..."}],
      "uncertainties": ["..."]
    }
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None, None, "skipped", None

    try:
        from openai import OpenAI
    except Exception:
        logger.exception("openai package not available")
        return None, None, "failed", None

    # Normalize language
    lang_n = _norm_lang(lang)
    out_lang = _LANG_LABELS.get(lang_n, "English")

    # Build context (up to 10)
    items: list[str] = []
    src_names: list[str] = []
    seen = set()

    for s in (sources or [])[:10]:
        src = (s.get("source_name") or "unknown").strip() or "unknown"
        if src.lower() not in seen:
            seen.add(src.lower())
            src_names.append(src)

        t = (s.get("title") or "").strip()
        d = (s.get("description") or "").strip()
        p = (s.get("published_at") or "").strip()
        if not t and not d:
            continue

        line = f"- [{src}]"
        if p:
            line += f" ({p})"
        if t:
            line += f" {t}"
        if d:
            line += f" — {d}"
        items.append(line)

    context = "\n".join(items) if items else "(no items)"
    sources_list_str = ", ".join(src_names[:12]) if src_names else "unknown"

    # Prompt in English but instruct to write in the selected language (works reliably)
    prompt = (
        f"You are a neutral news editor. Write in {out_lang}.\n"
        "Task: summarize ONE event using multiple sources and highlight disagreements.\n"
        "Do NOT add facts that are not present in the sources.\n\n"
        "CRITICAL:\n"
        "- Each diffs item MUST reference at least 2 specific sources.\n"
        "- Source names MUST be taken STRICTLY from the allowed list.\n"
        "- No vague wording like 'some sources'; use concrete source names only.\n\n"
        "Return STRICT JSON (no markdown, no extra text) with this schema:\n"
        "{\n"
        '  "brief": "2–4 sentences",\n'
        '  "key_facts": ["3–6 short facts strictly from the sources"],\n'
        '  "diffs": [{"sources":["A","B"],"difference":"..."}],\n'
        '  "uncertainties": ["0–4 short uncertainties (only if mentioned by sources)"]\n'
        "}\n\n"
        "Rules:\n"
        "- brief: 2–4 sentences.\n"
        "- key_facts: 3–6 items.\n"
        "- diffs: max 5 items.\n"
        "- uncertainties: 0–4 items.\n"
        "- If there are no material differences: return ONE diffs item with difference="
        "'No material differences were stated between sources.' and sources=[any 2 allowed sources].\n\n"
        f"Allowed source names: {sources_list_str}\n\n"
        f"Event title: {cluster_title}\n"
        f"Sources (title + description):\n{context}\n"
    )

    def _call(messages: list[dict[str, str]]) -> str:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.2,
        )
        return (resp.choices[0].message.content or "").strip()

    try:
        raw1 = _call(
            [
                {"role": "system", "content": "Return only valid JSON. No markdown."},
                {"role": "user", "content": prompt},
            ]
        )
        obj1 = _parse_json(raw1)
        if obj1 and _validate(obj1, sources):
            obj1["key_facts"] = (obj1.get("key_facts") or [])[:6]
            obj1["diffs"] = (obj1.get("diffs") or [])[:5]
            obj1["uncertainties"] = (obj1.get("uncertainties") or [])[:4]
            brief = (obj1.get("brief") or "").strip()
            return brief, json.dumps(obj1, ensure_ascii=False), "success", raw1

        raw2 = _call(
            [
                {"role": "system", "content": "Return only valid JSON. No markdown."},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": raw1},
                {
                    "role": "user",
                    "content": (
                        "Your output did not match the required JSON format/rules.\n"
                        "Fix it: return STRICT valid JSON in the exact schema.\n"
                        "Each diffs item: sources must have at least 2 names and ONLY from allowed list; "
                        "difference must be concrete and reference those sources.\n"
                    ),
                },
            ]
        )
        obj2 = _parse_json(raw2)
        if obj2 and _validate(obj2, sources):
            obj2["key_facts"] = (obj2.get("key_facts") or [])[:6]
            obj2["diffs"] = (obj2.get("diffs") or [])[:5]
            obj2["uncertainties"] = (obj2.get("uncertainties") or [])[:4]
            brief = (obj2.get("brief") or "").strip()
            return brief, json.dumps(obj2, ensure_ascii=False), "success", raw2

        logger.warning("AI output invalid after retry; storing raw text only")
        return None, None, "failed", raw2 or raw1

    except Exception:
        logger.exception("AI summary failed")
        return None, None, "failed", None
