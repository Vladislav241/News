from __future__ import annotations

import time
from typing import Dict, Optional, List

import httpx
from fastapi import APIRouter, Query, HTTPException


router = APIRouter(prefix="/api/market", tags=["market"])


# Very small in-memory cache (per-process). Keeps third-party calls stable.
_CACHE: Dict[str, Dict[str, object]] = {}


def _cache_get(key: str, ttl: float) -> Optional[object]:
    hit = _CACHE.get(key)
    if not hit:
        return None
    ts = float(hit.get("ts", 0.0) or 0.0)
    if (time.time() - ts) > ttl:
        return None
    return hit.get("val")


def _cache_set(key: str, val: object) -> None:
    _CACHE[key] = {"ts": time.time(), "val": val}


@router.get("/crypto")
async def market_crypto(
    vs: str = Query("eur", max_length=10),
    coins: str = Query("bitcoin,ethereum", max_length=300),
):
    """Proxy for simple crypto prices.

    Why: frontend direct calls can be rate-limited / blocked; proxy keeps CORS simple
    and adds caching.
    """

    vs0 = (vs or "eur").strip().lower()
    coin_list: List[str] = [c.strip().lower() for c in (coins or "").split(",") if c.strip()]
    coin_list = coin_list[:8]
    if not coin_list:
        raise HTTPException(status_code=400, detail="No coins")

    key = f"crypto:{vs0}:{','.join(coin_list)}"
    cached = _cache_get(key, ttl=25.0)
    if cached is not None:
        return cached

    url = "https://api.coingecko.com/api/v3/simple/price"
    params = {"ids": ",".join(coin_list), "vs_currencies": vs0}
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            r = await client.get(url, params=params)
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail="Upstream crypto error")
            data = r.json()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Upstream crypto unavailable")

    # Shape is already compatible with the widget: { coin: { vs: price } }
    _cache_set(key, data)
    return data


@router.get("/fx")
async def market_fx(
    base: str = Query("EUR", max_length=10),
    symbols: str = Query("USD,GBP,PLN,UAH", max_length=200),
):
    """Proxy for fiat FX rates.

    Uses a provider that supports a wide list of bases (including UAH).
    """

    base0 = (base or "EUR").strip().upper()
    syms: List[str] = [s.strip().upper() for s in (symbols or "").split(",") if s.strip()]
    syms = syms[:12]
    if not syms:
        raise HTTPException(status_code=400, detail="No symbols")

    key = f"fx:{base0}:{','.join(syms)}"
    cached = _cache_get(key, ttl=30.0)
    if cached is not None:
        return cached

    # Provider: open.er-api.com
    url = f"https://open.er-api.com/v6/latest/{base0}"
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail="Upstream fx error")
            data = r.json()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Upstream fx unavailable")

    rates = data.get("rates") if isinstance(data, dict) else None
    if not isinstance(rates, dict):
        raise HTTPException(status_code=502, detail="Invalid fx response")

    out_rates = {s: rates.get(s) for s in syms}
    out = {"base": base0, "rates": out_rates}
    _cache_set(key, out)
    return out
