from __future__ import annotations

import re
from typing import Optional


_ALIASES = [
    (r"\breuters\b", "reuters"),
    (r"\bap\b|\bassociated press\b|\bap news\b", "ap"),
    (r"\bbbc\b", "bbc"),
    (r"\bthe new york times\b|\bnytimes\b|\bnyt\b", "nyt"),
    (r"\bthe wall street journal\b|\bwsj\b", "wsj"),
    (r"\bthe guardian\b", "guardian"),
    (r"\bal jazeera\b", "aljazeera"),
    (r"\bdw\b|\bdeutsche welle\b", "dw"),
    (r"\bcnn\b", "cnn"),
    (r"\bnpr\b", "npr"),
    (r"\bsky news\b", "skynews"),
    (r"\baxios\b", "axios"),
    (r"\bpolitico\b", "politico"),
    (r"\bthe hill\b", "thehill"),
    (r"\bfinancial times\b|\bft\b", "ft"),
    (r"\bfrance ?24\b", "france24"),
    (r"\babc news\b", "abc"),
    (r"\bcbs news\b", "cbs"),
    (r"\bfox news\b", "fox"),
    (r"\btagesschau\b", "tagesschau"),
]


def normalize_source_key(source_name: str) -> str:
    n = (source_name or "").strip().lower()
    n = re.sub(r"\s+", " ", n)
    if not n:
        return "unknown"
    for pat, key in _ALIASES:
        if re.search(pat, n):
            return key
    n = re.sub(r"[^a-z0-9]+", "_", n).strip("_")
    return (n[:40] or "unknown")


def pick_best_display_name(names: list[str]) -> Optional[str]:
    clean = [x.strip() for x in (names or []) if (x or "").strip()]
    if not clean:
        return None
    clean.sort(key=lambda x: len(x), reverse=True)
    return clean[0]
