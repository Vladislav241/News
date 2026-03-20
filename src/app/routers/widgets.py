from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter

from ..db import db
from ..source_bias import normalize_domain, resolve_bias

router = APIRouter()
log = logging.getLogger("news.widgets")

_WIDGET_MEM_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_WIDGET_LOCKS: dict[str, threading.Lock] = {}
_WIDGET_LOCKS_GUARD = threading.Lock()


def _safe_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False)
    except Exception:
        return "{}"


def _cluster_cache_key(cluster_id: int, cluster_updated_at: str) -> str:
    basis = f"bias_widget:{int(cluster_id)}:{str(cluster_updated_at or '')}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def _ttl_seconds() -> int:
    base = 4 * 3600
    try:
        j = random.randint(-1800, 1800)
    except Exception:
        j = 0
    return max(3600, min(6 * 3600, base + j))


def _memory_ttl_seconds() -> int:
    try:
        return max(15, min(300, int(os.getenv("MEDIA_BIAS_MEMORY_CACHE_SECONDS", "90") or 90)))
    except Exception:
        return 90


def _max_llm_domains_per_request() -> int:
    try:
        return max(0, min(4, int(os.getenv("MEDIA_BIAS_MAX_LLM_DOMAINS_PER_REQUEST", "1") or 1)))
    except Exception:
        return 1


def _get_lock(cache_key: str) -> threading.Lock:
    with _WIDGET_LOCKS_GUARD:
        lock = _WIDGET_LOCKS.get(cache_key)
        if lock is None:
            lock = threading.Lock()
            _WIDGET_LOCKS[cache_key] = lock
        return lock


def _mem_get(cache_key: str) -> Optional[dict[str, Any]]:
    hit = _WIDGET_MEM_CACHE.get(cache_key)
    if not hit:
        return None
    ts, payload = hit
    if (time.time() - float(ts)) > float(_memory_ttl_seconds()):
        _WIDGET_MEM_CACHE.pop(cache_key, None)
        return None
    return payload


def _mem_set(cache_key: str, payload: dict[str, Any]) -> None:
    _WIDGET_MEM_CACHE[cache_key] = (time.time(), payload)


def _load_cached_payload(cache_key: str) -> Optional[dict[str, Any]]:
    mem = _mem_get(cache_key)
    if isinstance(mem, dict):
        return mem
    try:
        hit = db.get_media_bias_cache(cache_key)
        if hit:
            obj = json.loads(hit) if isinstance(hit, str) else hit
            if isinstance(obj, dict):
                _mem_set(cache_key, obj)
                return obj
    except Exception:
        log.exception("media-bias cache read failed")
    return None


def _store_payload(
    cache_key: str,
    cluster_id: int,
    payload: dict[str, Any],
    ttl_seconds: Optional[int] = None,
    cluster_updated_at: str = "",
) -> None:
    _mem_set(cache_key, payload)
    try:
        ttl = int(ttl_seconds) if ttl_seconds is not None else _ttl_seconds()
    except Exception:
        ttl = _ttl_seconds()
    try:
        db.set_media_bias_cache(
            cache_key,
            cluster_id,
            _safe_json(payload),
            ttl_seconds=ttl,
            cluster_updated_at=cluster_updated_at,
        )
    except Exception:
        log.exception("media-bias cache write failed for cluster %s", cluster_id)


def _negative_ttl_seconds() -> int:
    try:
        return max(120, min(1800, int(os.getenv("MEDIA_BIAS_NEGATIVE_CACHE_SECONDS", "600") or 600)))
    except Exception:
        return 600


@router.get("/api/widgets/media-bias")
def media_bias_widget(cluster_id: int):
    """
    Cluster-level Media Bias widget with aggressive cache reuse and per-cluster
    in-process dedupe, so repeated UI mounts do not fan out into parallel LLM calls.
    Never throws 500; returns best-effort data.
    """
    try:
        cid = int(cluster_id)
        if cid <= 0:
            return {"ok": True, "data": None, "reason": "bad_cluster_id"}
    except Exception:
        return {"ok": True, "data": None, "reason": "bad_cluster_id"}

    try:
        meta = db.get_cluster_meta(cid) or {}
        updated_at = meta.get("updated_at") or meta.get("created_at") or ""
    except Exception:
        updated_at = ""
    cache_key = _cluster_cache_key(cid, str(updated_at))

    cached = _load_cached_payload(cache_key)
    if isinstance(cached, dict):
        return {"ok": True, "cluster_id": cid, "data": cached.get("data"), "reason": cached.get("reason")}

    lock = _get_lock(cache_key)
    with lock:
        cached = _load_cached_payload(cache_key)
        if isinstance(cached, dict):
            return {"ok": True, "cluster_id": cid, "data": cached.get("data"), "reason": cached.get("reason")}

        try:
            sources = db.get_cluster_sources(cid) or []
        except Exception:
            sources = []

        outlet_rows: list[dict[str, Any]] = []
        seen_outlets: set[tuple[str, str]] = set()
        for s in sources:
            try:
                url = (s.get("url") or "").strip()
                domain = normalize_domain(url)
                if not domain:
                    continue
                source_name = (s.get("source_name") or domain).strip() or domain
                outlet_key = (source_name.casefold(), domain)
                if outlet_key in seen_outlets:
                    continue
                seen_outlets.add(outlet_key)
                title = (s.get("title") or "").strip()
                outlet_rows.append({
                    "name": source_name,
                    "domain": domain,
                    "titles": [title] if title else [],
                })
            except Exception:
                continue

        if len(outlet_rows) < 2:
            payload = {"data": None, "reason": "not_enough_sources"}
            _store_payload(cache_key, cid, payload, ttl_seconds=_negative_ttl_seconds(), cluster_updated_at=str(updated_at))
            return {"ok": True, "cluster_id": cid, "data": None, "reason": "not_enough_sources"}

        domain_titles: dict[str, list[str]] = {}
        for row in outlet_rows:
            domain_titles.setdefault(row["domain"], []).extend(row.get("titles") or [])

        domain_bias: dict[str, tuple[str, float, str]] = {}
        unresolved_domains: list[str] = []

        # First pass: resolve everything we can from DB / shipped seed data without spending LLM budget.
        for domain, titles in domain_titles.items():
            try:
                bias, conf, src = resolve_bias(domain, sample_titles=[])
            except Exception:
                bias, conf, src = ("unknown", 0.0, "unknown")
            if bias in ("left", "center", "right"):
                domain_bias[domain] = (bias, conf, src)
            else:
                unresolved_domains.append(domain)

        known_pre = sum(1 for v in domain_bias.values() if v[0] in ("left", "center", "right"))
        max_llm_domains = _max_llm_domains_per_request()
        # If we do not yet have enough classified outlets for a meaningful distribution,
        # spend a few LLM calls on the unresolved domains to avoid the widget being empty all the time.
        target_known = 2 if len(outlet_rows) >= 2 else 1
        llm_budget = max_llm_domains
        if known_pre < target_known:
            llm_budget = max(max_llm_domains, min(3, len(unresolved_domains)))

        llm_used = 0
        for domain in unresolved_domains:
            titles = domain_titles.get(domain) or []
            if llm_budget <= 0 or llm_used >= llm_budget:
                domain_bias[domain] = ("unknown", 0.0, "deferred")
                continue
            try:
                domain_bias[domain] = resolve_bias(domain, sample_titles=(titles or [])[:6])
            except Exception:
                domain_bias[domain] = ("unknown", 0.0, "unknown")
            llm_used += 1

        buckets: dict[str, dict[str, Any]] = {
            "left": {"count": 0, "sources": []},
            "center": {"count": 0, "sources": []},
            "right": {"count": 0, "sources": []},
            "unknown": {"count": 0, "sources": []},
        }
        conf_sum = 0.0
        conf_n = 0

        for row in outlet_rows:
            bias, conf, src = domain_bias.get(row["domain"], ("unknown", 0.0, "unknown"))
            if bias not in buckets:
                bias = "unknown"
            buckets[bias]["count"] += 1
            buckets[bias]["sources"].append({
                "domain": row["domain"],
                "name": row["name"],
                "confidence": conf,
                "source": src,
            })
            if bias != "unknown":
                conf_sum += float(conf or 0.0)
                conf_n += 1

        for key in buckets:
            buckets[key]["sources"].sort(key=lambda x: (str(x.get("name") or "").casefold(), str(x.get("domain") or "").casefold()))

        known_total = buckets["left"]["count"] + buckets["center"]["count"] + buckets["right"]["count"]
        total_unique = len(outlet_rows)
        if known_total <= 0:
            payload = {"data": None, "reason": "not_enough_bias_data"}
            _store_payload(cache_key, cid, payload, ttl_seconds=_negative_ttl_seconds(), cluster_updated_at=str(updated_at))
            return {"ok": True, "cluster_id": cid, "data": None, "reason": "not_enough_bias_data"}

        def pct(x: int) -> int:
            try:
                return int(round((x / known_total) * 100))
            except Exception:
                return 0

        data = {
            "left": {
                "count": buckets["left"]["count"],
                "percent": pct(buckets["left"]["count"]),
                "sources": buckets["left"]["sources"],
            },
            "center": {
                "count": buckets["center"]["count"],
                "percent": pct(buckets["center"]["count"]),
                "sources": buckets["center"]["sources"],
            },
            "right": {
                "count": buckets["right"]["count"],
                "percent": pct(buckets["right"]["count"]),
                "sources": buckets["right"]["sources"],
            },
            "unknown": {
                "count": buckets["unknown"]["count"],
                "sources": buckets["unknown"]["sources"],
            },
        }

        coverage = (known_total / total_unique) if total_unique > 0 else 0.0
        avg_conf = (conf_sum / conf_n) if conf_n else 0.0
        effective_conf = avg_conf * max(0.45, coverage)
        if effective_conf >= 0.75 and coverage >= 0.75:
            conf_label = "high"
        elif effective_conf >= 0.4:
            conf_label = "medium"
        else:
            conf_label = "low"
        data["confidence"] = conf_label
        data["coverage"] = int(round(coverage * 100))
        data["is_partial"] = known_total < total_unique

        payload = {"data": data, "reason": None}
        _store_payload(cache_key, cid, payload, cluster_updated_at=str(updated_at))
        return {"ok": True, "cluster_id": cid, "data": data}
