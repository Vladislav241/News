
from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..db import db
from ..source_bias import normalize_domain, resolve_bias

router = APIRouter()


def _safe_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False)
    except Exception:
        return "{}"


def _cluster_cache_key(cluster_id: int, cluster_updated_at: str) -> str:
    basis = f"bias_widget:{int(cluster_id)}:{str(cluster_updated_at or '')}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def _ttl_seconds() -> int:
    # 1-6 hours, a little jitter to avoid thundering herd
    base = 4 * 3600
    try:
        j = random.randint(-1800, 1800)  # +/- 30m
    except Exception:
        j = 0
    return max(3600, min(6 * 3600, base + j))


@router.get("/api/widgets/media-bias")
def media_bias_widget(cluster_id: int):
    """
    Cluster-level Media Bias widget:
    - counts sources in cluster by bias (left/center/right)
    - returns cached result keyed by cluster_id + cluster_updated_at
    Never throws 500 (best-effort fallbacks).
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
        cache_key = _cluster_cache_key(cid, str(updated_at))
    except Exception:
        updated_at = ""
        cache_key = _cluster_cache_key(cid, "")

    # Cache hit
    try:
        hit = db.get_media_bias_cache(cache_key)
        if hit and hit.get("payload_json"):
            obj = json.loads(hit["payload_json"]) if isinstance(hit["payload_json"], str) else hit["payload_json"]
            if isinstance(obj, dict):
                obj["cache"] = "hit"
                return {"ok": True, "cluster_id": cid, "data": obj.get("data"), "reason": obj.get("reason")}
    except Exception:
        pass

    # Compute
    try:
        sources = db.get_cluster_sources(cid) or []
    except Exception:
        sources = []

    # Extract domains and keep display names
    domains: list[str] = []
    domain_to_names: dict[str, set[str]] = {}
    domain_to_titles: dict[str, list[str]] = {}
    for s in sources:
        try:
            url = (s.get("url") or "").strip()
            d = normalize_domain(url)
            if not d:
                continue
            domains.append(d)
            domain_to_names.setdefault(d, set()).add((s.get("source_name") or d).strip() or d)
            title = (s.get("title") or "").strip()
            if title:
                domain_to_titles.setdefault(d, []).append(title)
        except Exception:
            continue

    unique_domains = sorted(set(domains))
    if len(unique_domains) < 2:
        payload = {"data": None, "reason": "not_enough_sources"}
        try:
            db.set_media_bias_cache(cache_key, cid, str(updated_at), _safe_json(payload), ttl_seconds=_ttl_seconds())
        except Exception:
            pass
        return {"ok": True, "cluster_id": cid, "data": None, "reason": "not_enough_sources"}

    buckets: dict[str, dict[str, Any]] = {
        "left": {"count": 0, "sources": []},
        "center": {"count": 0, "sources": []},
        "right": {"count": 0, "sources": []},
        "unknown": {"count": 0, "sources": []},
    }

    conf_sum = 0.0
    conf_n = 0

    for d in unique_domains:
        titles = (domain_to_titles.get(d) or [])[:6]
        bias, conf, src = resolve_bias(d, sample_titles=titles)
        if bias not in buckets:
            bias = "unknown"
        buckets[bias]["count"] += 1
        # use pretty names if we have them
        names = sorted(domain_to_names.get(d) or {d})
        buckets[bias]["sources"].append({
            "domain": d,
            "names": names,
            "confidence": conf,
            "source": src,
        })
        if bias != "unknown":
            conf_sum += float(conf or 0.0)
            conf_n += 1

    known_total = buckets["left"]["count"] + buckets["center"]["count"] + buckets["right"]["count"]

    if known_total < 2:
        payload = {"data": None, "reason": "not_enough_bias_data"}
        try:
            db.set_media_bias_cache(cache_key, cid, str(updated_at), _safe_json(payload), ttl_seconds=_ttl_seconds())
        except Exception:
            pass
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

    avg_conf = (conf_sum / conf_n) if conf_n else 0.0
    if avg_conf >= 0.75:
        conf_label = "high"
    elif avg_conf >= 0.45:
        conf_label = "medium"
    else:
        conf_label = "low"
    data["confidence"] = conf_label

    payload = {"data": data, "reason": None}

    try:
        db.set_media_bias_cache(cache_key, cid, str(updated_at), _safe_json(payload), ttl_seconds=_ttl_seconds())
    except Exception:
        pass

    return {"ok": True, "cluster_id": cid, "data": data}
