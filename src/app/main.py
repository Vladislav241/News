# src/app/main.py
from __future__ import annotations

import os
import asyncio
import logging
from typing import Optional

# Load .env automatically for local development
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .db import db
from .ingest import run_ingest_cycle
from .routers.debug import router as debug_router
from .routers.health import router as health_router
from .routers.news import router as news_router

log = logging.getLogger("news.autorefresh")

app = FastAPI(title="NEWS")

# ---------- CORS ----------
allowed_origins = os.getenv("CORS_ORIGINS", "*").split(",")
allowed_origins = [o.strip() for o in allowed_origins if o.strip()] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Routers ----------
app.include_router(health_router)
app.include_router(news_router)
app.include_router(debug_router)

# ---------- Static frontend ----------
# If your repo layout is different, adjust these paths.
app.mount("/static", StaticFiles(directory="src/web"), name="static")
app.mount("/", StaticFiles(directory="src/web", html=True), name="web")

# ---------- Auto refresh loop ----------
_auto_task: Optional[asyncio.Task] = None
_ingest_lock = asyncio.Lock()


def _env_bool(name: str, default: bool = True) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip().lower()
    return v not in ("0", "false", "no", "off", "")


def _get_refresh_interval_seconds() -> int:
    """
    Priority:
    1) .env REFRESH_INTERVAL_SECONDS if set
    2) db.get_config().refresh_interval_seconds if present
    3) default 600 (10 minutes)
    """
    env_val = os.getenv("REFRESH_INTERVAL_SECONDS")
    if env_val:
        try:
            return max(0, int(env_val))
        except Exception:
            pass

    try:
        cfg = db.get_config()
        v = int(cfg.refresh_interval_seconds or 0)
        if v > 0:
            return v
    except Exception:
        pass

    return 600


async def _auto_refresh_loop() -> None:
    """Periodic ingest so the feed updates server-side (users don't need to press Refresh)."""
    # Run once shortly after boot so fresh deploys don't stay empty for many minutes.
    await asyncio.sleep(2.0)
    first = True

    while True:
        try:
            enabled = _env_bool("AUTO_REFRESH", True)
            interval = _get_refresh_interval_seconds()

            if not enabled or interval <= 0:
                await asyncio.sleep(5.0)
                continue

            # Wait between cycles (but don't delay the very first run)
            if not first:
                await asyncio.sleep(float(interval))
            first = False

            # Prevent overlapping cycles
            async with _ingest_lock:
                db.ensure_schema()
                # run_ingest_cycle is CPU/IO bound and synchronous
                await asyncio.to_thread(run_ingest_cycle)

        except asyncio.CancelledError:
            break
        except Exception as e:
            log.exception("auto refresh failed: %s", e)
            await asyncio.sleep(10.0)


@app.on_event("startup")
async def _startup_autorefresh() -> None:
    global _auto_task
    # ensure DB schema at boot
    try:
        db.ensure_schema()
    except Exception:
        log.exception("ensure_schema failed on startup")

    if _auto_task is None:
        _auto_task = asyncio.create_task(_auto_refresh_loop())
        log.info("auto refresh loop started")


@app.on_event("shutdown")
async def _shutdown_autorefresh() -> None:
    global _auto_task
    if _auto_task is not None:
        _auto_task.cancel()
        _auto_task = None
        log.info("auto refresh loop stopped")
