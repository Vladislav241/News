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

    Returns the SAME shape as Coingecko simple/price:
      { "bitcoin": { "eur": 123 }, "ethereum": { "eur": 45 } }
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
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            r = await client.get(url, params=params)
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Upstream crypto error ({r.status_code})")
            data = r.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Upstream crypto unavailable: {type(e).__name__}")

    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=502, detail="Invalid crypto response")

    _cache_set(key, data)
    return data

@router.get("/fx")
async def market_fx(
    base: str = Query("EUR", max_length=10),
    symbols: str = Query("USD,GBP,PLN,UAH", max_length=200),
):
    """Proxy for fiat FX rates.

    Output shape is always:
      { "base": "EUR", "rates": { "USD": 1.08, ... } }
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

    # 1) Try open.er-api.com
    rates: Optional[dict] = None
    try:
        url = f"https://open.er-api.com/v6/latest/{base0}"
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and isinstance(data.get("rates"), dict):
                    rates = data["rates"]
    except Exception:
        rates = None

    # 2) Fallback: frankfurter (doesn't support all bases, but helps when er-api is blocked)
    if rates is None:
        try:
            url = "https://api.frankfurter.app/latest"
            params = {"from": base0, "to": ",".join(syms)}
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                r = await client.get(url, params=params)
                if r.status_code == 200:
                    data = r.json()
                    if isinstance(data, dict) and isinstance(data.get("rates"), dict):
                        rates = data["rates"]
        except Exception:
            rates = None

    if not isinstance(rates, dict):
        raise HTTPException(status_code=502, detail="Upstream fx unavailable")

    # Case-insensitive lookup + filter to requested symbols only
    upper_map = {str(k).upper(): v for k, v in rates.items()}
    out_rates = {}
    for s in syms:
        v = upper_map.get(s)
        if isinstance(v, (int, float)) and v > 0:
            out_rates[s] = float(v)

    if not out_rates:
        raise HTTPException(status_code=502, detail="Upstream fx returned no requested symbols")

    out = {"base": base0, "rates": out_rates}
    _cache_set(key, out)
    return out
