from __future__ import annotations

import json
import base64
import logging
import os
import re
import time
from typing import Any, Optional, Tuple

from .db import db

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


def _sanitize_summary_obj(obj: dict[str, Any], sources: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """
    Normalize model output into a stable summary payload.

    The previous implementation rejected the whole summary whenever `diffs`
    referenced unknown sources or used vague wording. In production that caused
    many stories to stay without an AI summary for hours even though the model
    returned a usable brief. Here we salvage the valid parts and synthesize a
    safe fallback `diffs` item when needed.
    """
    if not isinstance(obj, dict):
        return None

    brief = str(obj.get("brief") or obj.get("summary") or obj.get("text") or "").strip()
    brief = re.sub(r"\s+", " ", brief)
    if not brief:
        return None

    known_names = []
    known_lc_to_real = {}
    for s in (sources or []):
        name = str(s.get("source_name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key not in known_lc_to_real:
            known_lc_to_real[key] = name
            known_names.append(name)

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

    key_facts = []
    for x in (obj.get("key_facts") or [])[:6]:
        s = re.sub(r"\s+", " ", str(x or "")).strip()
        if s and s not in key_facts:
            key_facts.append(s)
    if not key_facts:
        for src in (sources or [])[:3]:
            candidate = re.sub(r"\s+", " ", str(src.get("title") or src.get("description") or "")).strip()
            if candidate and candidate not in key_facts:
                key_facts.append(candidate)
            if len(key_facts) >= 3:
                break

    uncertainties = []
    for x in (obj.get("uncertainties") or [])[:4]:
        s = re.sub(r"\s+", " ", str(x or "")).strip()
        if s and s not in uncertainties:
            uncertainties.append(s)

    diffs = []
    for d in (obj.get("diffs") or [])[:5]:
        if not isinstance(d, dict):
            continue
        raw_sources = d.get("sources") or []
        mapped = []
        for name in raw_sources:
            key = str(name or "").strip().lower()
            real = known_lc_to_real.get(key)
            if real and real not in mapped:
                mapped.append(real)
        difference = re.sub(r"\s+", " ", str(d.get("difference") or "")).strip()
        if len(mapped) >= 2 and difference and not vague_re.search(difference):
            diffs.append({"sources": mapped[:4], "difference": difference})

    if not diffs and len(known_names) >= 2:
        diffs = [{
            "sources": known_names[:2],
            "difference": "No material differences were stated between sources.",
        }]

    return {
        "brief": brief,
        "key_facts": key_facts[:6],
        "diffs": diffs[:5],
        "uncertainties": uncertainties[:4],
    }


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

    # Build context (up to 6)
    items: list[str] = []
    src_names: list[str] = []
    seen = set()

    for s in (sources or [])[:6]:
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

    def _call(messages: list[dict[str, str]]) -> tuple[str, dict[str, Any]]:
        client = OpenAI(api_key=api_key)
        started = time.perf_counter()
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0,
            max_tokens=320,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "cluster_summary",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "brief": {"type": "string"},
                            "key_facts": {"type": "array", "items": {"type": "string"}},
                            "diffs": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "sources": {"type": "array", "items": {"type": "string"}},
                                        "difference": {"type": "string"}
                                    },
                                    "required": ["sources", "difference"],
                                    "additionalProperties": False
                                }
                            },
                            "uncertainties": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["brief", "key_facts", "diffs", "uncertainties"],
                        "additionalProperties": False
                    }
                }
            },
        )
        usage = getattr(resp, "usage", None)
        meta = {
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "prompt_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "completion_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
            "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
        }
        return (resp.choices[0].message.content or "").strip(), meta

    try:
        raw1, usage_meta = _call(
            [
                {"role": "system", "content": "Return only valid JSON. No markdown."},
                {"role": "user", "content": prompt},
            ]
        )
        obj1 = _parse_json(raw1)
        sanitized = _sanitize_summary_obj(obj1, sources) if obj1 else None
        if sanitized:
            brief = (sanitized.get("brief") or "").strip()
            status_name = "success"
            try:
                db.log_ai_usage(
                    feature="cluster_summary",
                    model=model,
                    status=status_name,
                    cache_hit=False,
                    latency_ms=usage_meta.get("latency_ms"),
                    prompt_tokens=usage_meta.get("prompt_tokens"),
                    completion_tokens=usage_meta.get("completion_tokens"),
                    total_tokens=usage_meta.get("total_tokens"),
                    meta={"sources": len(sources or []), "lang": lang_n},
                )
            except Exception:
                pass
            return brief, json.dumps(sanitized, ensure_ascii=False), status_name, raw1

        logger.warning("AI summary output invalid; storing raw text only")
        try:
            db.log_ai_usage(
                feature="cluster_summary",
                model=model,
                status="invalid_output",
                cache_hit=False,
                latency_ms=usage_meta.get("latency_ms"),
                prompt_tokens=usage_meta.get("prompt_tokens"),
                completion_tokens=usage_meta.get("completion_tokens"),
                total_tokens=usage_meta.get("total_tokens"),
                meta={"sources": len(sources or []), "lang": lang_n},
            )
        except Exception:
            pass
        fallback_brief = re.sub(r"\s+", " ", _unwrap_fenced(raw1 or "")).strip()
        if fallback_brief:
            fallback_brief = fallback_brief[:900].strip()
            fallback_obj = {
                "brief": fallback_brief,
                "key_facts": [],
                "diffs": [],
                "uncertainties": [],
            }
            return fallback_brief, json.dumps(fallback_obj, ensure_ascii=False), "success", raw1
        return None, None, "failed", raw1

    except Exception:
        logger.exception("AI summary failed")
        try:
            db.log_ai_usage(feature="cluster_summary", model=model, status="exception", cache_hit=False, meta={"sources": len(sources or []), "lang": lang_n})
        except Exception:
            pass
        return None, None, "failed", None



def extract_visual_search_signal(
    image_bytes: bytes,
    mime_type: str = "image/png",
    ui_lang: str = "en",
    model: str = "gpt-4.1-mini",
) -> dict[str, Any]:
    """
    Extract OCR-like text + a concise search query from an uploaded screenshot/news image.

    Returns:
      {
        "query": "...",
        "text": "...",
        "language": "en",
        "confidence": 0.0-1.0,
      }

    Raises RuntimeError when OPENAI_API_KEY is not configured or parsing fails.
    """
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    try:
        from openai import OpenAI
    except Exception as e:
        raise RuntimeError("openai package is not available") from e

    if not image_bytes:
        raise RuntimeError("Empty image payload")

    lang_n = _norm_lang(ui_lang or "en")
    out_lang = _LANG_LABELS.get(lang_n, "English")

    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{mime_type or 'image/png'};base64,{b64}"

    prompt = (
        "You analyze screenshots of news headlines/articles/posts in ANY language.\n"
        f"Return STRICT JSON only. Write the `query` in {out_lang} when possible, but keep unique names, places, numbers, acronyms and quoted phrases exactly as in the image.\n"
        "Goal: produce a high-recall query for finding the same or very similar news in a feed, even when the feed headline is paraphrased.\n"
        "Rules:\n"
        "- Prefer the MAIN event from the screenshot, not side details.\n"
        "- Keep the key entities exactly: countries, leaders, cities, companies, casualty numbers, dates, quoted labels, military operation names.\n"
        "- Ignore UI chrome, timestamps, buttons, ads, emoji, usernames unless essential.\n"
        "- The query should be 6 to 18 words and optimized for retrieval, not for readability.\n"
        "- If the screenshot shows a headline plus subheadline, merge them into one stronger search query.\n"
        "- If the screenshot contains article paragraphs instead of a headline, derive the query from the strongest event sentence and the key entities.\n"
        "- Prefer exact distinctive names and phrases over generic verbs like says, touts, reacts, after, ahead.\n"
        "- If there are multiple readable variants of the headline, choose the one with the highest information density.\n"
        "- `text` should be a compact OCR-style extraction of the strongest readable lines and paragraph snippets (max 900 chars).\n"
        "- `language` should be the dominant language code if obvious, else 'unknown'.\n"
        "- `confidence` is 0..1.\n"
        "Schema:\n"
        "{\"query\":\"...\",\"text\":\"...\",\"language\":\"en\",\"confidence\":0.82}"
    )

    client = OpenAI(api_key=api_key)
    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=0.1,
            max_tokens=280,
            messages=[
                {"role": "system", "content": "Return only valid JSON. No markdown."},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                },
            ],
        )
    except Exception as e:
        raise RuntimeError(f"Vision extraction failed: {e}") from e

    raw = ""
    try:
        raw = (resp.choices[0].message.content or "").strip()
    except Exception:
        raw = ""

    obj = _parse_json(raw or "")
    if not obj:
        raise RuntimeError("Could not parse visual-search JSON output")

    query = str(obj.get("query") or "").strip()
    text = str(obj.get("text") or "").strip()
    language = str(obj.get("language") or "unknown").strip().lower() or "unknown"
    try:
        confidence = float(obj.get("confidence") or 0.0)
    except Exception:
        confidence = 0.0

    if not query and text:
        query = text[:160].strip()
    if not query:
        raise RuntimeError("No usable query extracted from image")

    return {
        "query": query[:120],
        "text": text[:900],
        "language": language[:16],
        "confidence": max(0.0, min(1.0, confidence)),
    }
