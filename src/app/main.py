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
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.gzip import GZipMiddleware

from starlette.middleware.base import BaseHTTPMiddleware

from .db import db
from .ingest import run_ingest_cycle, process_fulltext_queue_once
from .notify import notify_loop
#from .routers.debug import router as debug_router
from .routers.health import router as health_router
from .routers.auth import router as auth_router
from .routers.news import router as news_router
from .routers.billing import router as billing_router
from .routers.stats import router as stats_router
from .routers.share import router as share_router
from .routers.alerts import router as alerts_router
from .auth.deps import csrf_origin_check
from .routers import debug
from .guest_tracker import mark as mark_guest

log = logging.getLogger("news.autorefresh")

app = FastAPI(title="NEWS")

from .routers.debug import router as debug_router

#  app.include_router(debug_router)

# GZip responses (helps a lot on slow/cheap hosts)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# ---------- CORS ----------
allowed_origins = os.getenv("CORS_ORIGINS", "*").split(",")
allowed_origins = [o.strip() for o in allowed_origins if o.strip()] or ["*"]

allow_credentials = (os.getenv("CORS_ALLOW_CREDENTIALS") or "0").strip().lower() in ("1", "true", "yes")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # Guest online tracking (approximate; resets on container restart)
        try:
            mark_guest(getattr(getattr(request, "client", None), "host", None))
        except Exception:
            pass
        # CSRF origin check for cookie auth
        try:
            csrf_origin_check(request)
        except HTTPException as e:
            return JSONResponse(status_code=e.status_code, content={"detail": e.detail})

        resp = await call_next(request)

        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        # Keep CSP minimal to avoid breaking your current inline styles.
        # You can harden later once you move CSS to files.
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self' https:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https:;",
        )
        return resp


app.add_middleware(SecurityHeadersMiddleware)

# ---------- Static frontend ----------
# Serve /static/* first. We'll mount the SPA (/) at the very end.
app.mount("/static", StaticFiles(directory="src/web"), name="static")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    """Avoid noisy 404s in the browser console."""
    # The project stores icons directly under src/web/icons
    # (and /static is mounted to src/web).
    path = os.path.join("src", "web", "icons", "Logo.svg")
    if os.path.exists(path):
        return FileResponse(path, media_type="image/svg")
    # Fallback: return a 404 if the file isn't there
    return Response(status_code=404)


# ---------- Routers ----------
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(news_router)
app.include_router(alerts_router)
app.include_router(billing_router)
app.include_router(stats_router)
app.include_router(share_router)
app.include_router(debug_router)

# Mount the frontend last so it doesn't swallow API routes (and /favicon.ico).
app.mount("/", StaticFiles(directory="src/web", html=True), name="web")

# ---------- Auto refresh loop ----------
_auto_task: Optional[asyncio.Task] = None
_notify_task: Optional[asyncio.Task] = None

_fulltext_task: Optional[asyncio.Task] = None
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




async def _fulltext_loop() -> None:
    """Background fulltext extractor.

    This keeps ingest fast: users see normal scores immediately, while
    article-only text is fetched in the background to improve clustering quality.
    """
    # small warmup delay
    await asyncio.sleep(3.0)

    # small, bounded budget per tick
    while True:
        try:
            if not _env_bool("FULLTEXT_WORKER", True):
                await asyncio.sleep(5.0)
                continue

            max_jobs = int(os.getenv("FULLTEXT_MAX_JOBS_PER_TICK", "6") or 6)
            workers = int(os.getenv("FULLTEXT_MAX_WORKERS", "6") or 6)

            # run sync worker in a thread
            await asyncio.to_thread(process_fulltext_queue_once, max_jobs, workers)

            # short pause; keeps CPU/network stable
            await asyncio.sleep(float(os.getenv("FULLTEXT_TICK_SECONDS", "2") or 2))

        except asyncio.CancelledError:
            break
        except Exception as e:
            log.exception("fulltext loop failed: %s", e)
            await asyncio.sleep(5.0)

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

    global _fulltext_task
    if _fulltext_task is None:
        _fulltext_task = asyncio.create_task(_fulltext_loop())
        log.info("fulltext loop started")

    global _notify_task
    if _notify_task is None:
        _notify_task = asyncio.create_task(notify_loop())
        log.info("notify loop started")


@app.on_event("shutdown")
async def _shutdown_autorefresh() -> None:
    global _auto_task
    if _auto_task is not None:
        _auto_task.cancel()
        _auto_task = None
        log.info("auto refresh loop stopped")


    global _fulltext_task
    if _fulltext_task is not None:
        _fulltext_task.cancel()
        _fulltext_task = None
        log.info("fulltext loop stopped")

    global _notify_task
    if _notify_task is not None:
        _notify_task.cancel()
        _notify_task = None
        log.info("notify loop stopped")
