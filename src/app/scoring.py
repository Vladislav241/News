from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .clustering import has_clickbait
from .sources import normalize_source_key


SOURCE_WEIGHTS = {
    "reuters": 1.0,
    "ap": 1.0,
    "bbc": 0.9,
    "ft": 0.9,
    "guardian": 0.85,
    "dw": 0.85,
    "aljazeera": 0.8,
    "nyt": 0.9,
    "wsj": 0.9,
    "cnn": 0.7,
    "skynews": 0.7,
    "npr": 0.75,
    "axios": 0.75,
    "politico": 0.75,
    "thehill": 0.7,
    "france24": 0.75,
    "abc": 0.7,
    "cbs": 0.7,
    "fox": 0.6,
    "tagesschau": 0.8,
}
DEFAULT_WEIGHT = 0.55


def _source_weight_by_key(source_key: str) -> float:
    return float(SOURCE_WEIGHTS.get(source_key or "unknown", DEFAULT_WEIGHT))


def _parse_iso(iso: str) -> datetime | None:
    try:
        if not iso:
            return None
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None


def compute_importance(cluster_updated_at_iso: str, sources_count: int, latest_published_at_iso: str | None = None) -> int:
    """
    importance 0–100:
    - источники главный драйвер
    - свежесть по latest_published_at (если есть)
    """
    base = 25
    base += min(50, sources_count * 8)

    now = datetime.now(timezone.utc)
    dt = _parse_iso(latest_published_at_iso or "") or _parse_iso(cluster_updated_at_iso or "")
    if dt:
        age_h = max(0.0, (now - dt).total_seconds() / 3600.0)
        # 0h => +20, 24h => +10, 72h => +3, >7d => 0
        if age_h <= 24:
            base += 20 - int(age_h * 0.4)
        elif age_h <= 72:
            base += 10 - int((age_h - 24) * 0.15)
        elif age_h <= 7 * 24:
            base += 3
    return max(0, min(100, int(base)))


def compute_credibility(cluster_title: str, sources: list[dict[str, Any]]) -> tuple[int, dict[str, Any]]:
    """
    Credibility 0–100:
    - unique независимые источники по source_key
    - репутация источников (avg + top)
    - diversity: много слабых источников не даёт сильного роста
    - штраф за кликбейт
    """
    factors: list[dict[str, Any]] = []
    title = (cluster_title or "").strip()

    # unique sources by key
    uniq: dict[str, dict[str, Any]] = {}
    for s in sources or []:
        name = (s.get("source_name") or "unknown").strip()
        key = (s.get("source_key") or "").strip() or normalize_source_key(name)
        if key not in uniq:
            uniq[key] = {"source_key": key, "source_name": name}

    unique_count = len(uniq)

    if unique_count <= 1:
        impact = 0
        desc = "Пока найден только один источник — подтверждений мало."
    elif unique_count == 2:
        impact = 12
        desc = "Есть 2 независимых источника — подтверждение начинает формироваться."
    elif 3 <= unique_count <= 4:
        impact = 22
        desc = f"Новость подтверждена {unique_count} независимыми источниками."
    else:
        impact = 30
        desc = f"Новость подтверждена {unique_count} независимыми источниками — сильный сигнал."
    factors.append({"name": "Подтверждение источниками", "impact": impact, "description": desc})

    weights = []
    for s in sources or []:
        name = (s.get("source_name") or "").strip()
        key = (s.get("source_key") or "").strip() or normalize_source_key(name)
        weights.append(_source_weight_by_key(key))
    if not weights:
        weights = [DEFAULT_WEIGHT]

    avg_w = sum(weights) / max(1, len(weights))
    max_w = max(weights)

    # diversity: if most are low-weight, reduce effect of count
    high = sum(1 for w in weights if w >= 0.8)
    mid = sum(1 for w in weights if 0.65 <= w < 0.8)
    low = sum(1 for w in weights if w < 0.65)
    diversity = (high * 1.0 + mid * 0.6 + low * 0.25) / max(1, len(weights))

    rep_impact = int(round((avg_w - 0.5) * 38))
    rep_impact = max(-10, min(22, rep_impact))

    div_impact = int(round((diversity - 0.45) * 24))
    div_impact = max(-8, min(12, div_impact))

    factors.append(
        {
            "name": "Репутация источников",
            "impact": rep_impact,
            "description": f"Средний вес: {avg_w:.2f}, макс.: {max_w:.2f}.",
        }
    )
    factors.append(
        {
            "name": "Диверсификация источников",
            "impact": div_impact,
            "description": f"Доля сильных/средних/слабых (нормировано): {diversity:.2f}.",
        }
    )

    if has_clickbait(title):
        factors.append(
            {
                "name": "Кликбейт/эмоциональная лексика",
                "impact": -10,
                "description": "Заголовок содержит эмоциональные или манипулятивные формулировки.",
            }
        )

    score = 50 + sum(int(f["impact"]) for f in factors)

    if unique_count <= 1:
        score = min(score, 62)

    score = max(0, min(100, int(score)))

    negatives = [f for f in factors if f["impact"] < 0]
    if score >= 80:
        summary = "Высокий балл: событие подтверждается несколькими источниками и/или надёжными СМИ."
    elif score >= 60:
        summary = "Средний балл: подтверждения есть, но их пока недостаточно либо источники разного качества."
    else:
        summary = "Низкий балл: мало независимых подтверждений и/или слабая репутация источников."
    if negatives:
        summary += " Есть факторы, которые снижают оценку."

    details = {
        "final_score": score,
        "factors": factors,
        "summary": summary,
        "meta": {
            "unique_sources": unique_count,
            "avg_source_weight": round(avg_w, 3),
            "max_source_weight": round(max_w, 3),
            "diversity": round(density := diversity, 3),  # keep stable key
        },
    }
    return score, details
