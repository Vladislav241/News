from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional, Tuple

logger = logging.getLogger("news.ai")


def verify_same_story(
    a_title: str,
    a_desc: str,
    b_title: str,
    b_desc: str,
    model: str = "gpt-4o-mini",
) -> bool:
    """Binary gate: check if two headlines/descriptions refer to the same event.

    This is intentionally short to keep token cost low.
    If OPENAI_API_KEY is not set, returns True (so the pipeline still works offline).
    """
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return True

    # Import lazily to avoid import-time issues during local/offline runs.
    from openai import OpenAI

    try:
        client = OpenAI(api_key=api_key)

        def clip(s: str, n: int = 380) -> str:
            s = (s or "").strip().replace("\n", " ")
            return s[:n]

        prompt = (
            "Decide if A and B describe the SAME real-world news story/event.\n"
            "Answer ONLY with 'YES' or 'NO'.\n\n"
            f"A title: {clip(a_title)}\n"
            f"A desc: {clip(a_desc)}\n\n"
            f"B title: {clip(b_title)}\n"
            f"B desc: {clip(b_desc)}\n"
        )

        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a strict news deduplication classifier."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=3,
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
    if not isinstance(obj.get("brief"), str) or not obj["brief"].strip():
        return False
    if not isinstance(obj.get("key_facts"), list) or not obj["key_facts"]:
        return False
    if not isinstance(obj.get("diffs"), list) or not obj["diffs"]:
        return False
    if "uncertainties" in obj and not isinstance(obj["uncertainties"], list):
        return False

    known = {(s.get("source_name") or "").strip() for s in sources or []}
    known = {x for x in known if x}

    def ok_src_list(lst: Any) -> bool:
        if not isinstance(lst, list):
            return False
        ss = [str(x).strip() for x in lst if str(x).strip()]
        if len(ss) < 2:
            return False
        # must be from known list (strict-ish)
        return all((x in known) for x in ss[:2])

    for d in obj["diffs"][:5]:
        if not isinstance(d, dict):
            return False
        if not ok_src_list(d.get("sources")):
            return False
        if not isinstance(d.get("difference"), str) or not d["difference"].strip():
            return False
        # block vague
        if re.search(r"\b(некоторые|другие|часть источников)\b", d["difference"], re.IGNORECASE):
            return False
    return True


def summarize_cluster(
    cluster_title: str,
    sources: list[dict[str, Any]],
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

    # Build context (up to 10)
    items: list[str] = []
    src_names = []
    seen = set()

    for s in (sources or [])[:10]:
        src = (s.get("source_name") or "unknown").strip()
        if src and src.lower() not in seen:
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

    prompt = (
        "Ты — нейтральный редактор новостей. Пиши по-русски.\n"
        "Задача: коротко пересказать событие по нескольким источникам и показать расхождения.\n"
        "НЕ добавляй фактов, которых нет в источниках.\n\n"
        "КРИТИЧНО:\n"
        "- Каждый пункт diffs ОБЯЗАН ссылаться минимум на 2 конкретных источника.\n"
        "- Названия источников бери СТРОГО из списка допустимых.\n"
        "- Никаких 'некоторые/другие источники' — только конкретные.\n\n"
        "Верни СТРОГО JSON (без markdown, без пояснений) вида:\n"
        "{\n"
        '  "brief": "2–4 предложения",\n'
        '  "key_facts": ["3–6 коротких фактов строго из источников"],\n'
        '  "diffs": [\n'
        '    {"sources":["Source A","Source B"],"difference":"В Source A сказано X, а в Source B — Y."}\n'
        "  ],\n"
        '  "uncertainties": ["1–4 пункта: что неясно/не подтверждено по источникам"]\n'
        "}\n\n"
        "Правила:\n"
        "- brief: 2–4 предложения.\n"
        "- key_facts: 3–6 буллетов.\n"
        "- diffs: максимум 5 пунктов.\n"
        "- uncertainties: 0–4 пунктов.\n"
        "- Если существенных различий нет: верни ОДИН diffs пункт с difference='Существенных различий между источниками не указано.' "
        "и sources=[<любой источник 1>, <любой источник 2>].\n\n"
        f"Список допустимых источников: {sources_list_str}\n\n"
        f"Событие (черновой заголовок): {cluster_title}\n"
        f"Публикации источников:\n{context}\n"
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
                        "Твой ответ не соответствует формату/требованиям.\n"
                        "Исправь: верни СТРОГО валидный JSON указанного вида.\n"
                        "Каждый diffs пункт: sources минимум 2 и только из списка допустимых; difference конкретный.\n"
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

        # fallback: сохраняем raw, но в json не верим
        logger.warning("AI output invalid after retry; storing raw text only")
        return None, None, "failed", raw2 or raw1

    except Exception:
        logger.exception("AI summary failed")
        return None, None, "failed", None
