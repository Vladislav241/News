from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Optional

# Load .env automatically for local development
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware

from .db import db
from .guest_tracker import mark as mark_guest
from .ingest import process_fulltext_queue_once, run_ingest_cycle
from .notify import notify_loop
from .auth.deps import csrf_origin_check
from .routers.alerts import router as alerts_router
from .routers.auth import router as auth_router
from .routers.billing import router as billing_router
from .routers.health import router as health_router
from .routers.image import router as image_router
from .routers.interests import router as interests_router
from .routers.market import router as market_router
from .routers.news import router as news_router
from .routers.promo import router as promo_router
from .routers.report import router as report_router
from .routers.share import router as share_router
from .routers.stats import router as stats_router
from .routers.status import router as status_router
from .routers.unsubscribe import router as unsubscribe_router
from .routers.widgets import router as widgets_router
from .runtime import background_tasks_disabled, env_bool, is_production, request_id_ctx, require_env

log = logging.getLogger("news.autorefresh")
request_log = logging.getLogger("news.requests")
app_log = logging.getLogger("news.app")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get("-")
        return True


def _configure_logging() -> None:
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] [request_id=%(request_id)s] %(message)s"
        ))
        handler.addFilter(RequestIdFilter())
        root.addHandler(handler)
    else:
        for handler in root.handlers:
            handler.addFilter(RequestIdFilter())
            if handler.formatter is None:
                handler.setFormatter(logging.Formatter(
                    "%(asctime)s %(levelname)s [%(name)s] [request_id=%(request_id)s] %(message)s"
                ))
    root.setLevel(getattr(logging, (os.getenv("LOG_LEVEL") or "INFO").upper(), logging.INFO))


_configure_logging()


def _init_sentry() -> None:
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        sentry_sdk.init(
            dsn=dsn,
            environment=(os.getenv("APP_ENV") or "development").strip().lower(),
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE") or 0.0),
            profiles_sample_rate=float(os.getenv("SENTRY_PROFILES_SAMPLE_RATE") or 0.0),
            integrations=[FastApiIntegration(), StarletteIntegration()],
        )
        app_log.info("sentry enabled")
    except Exception:
        app_log.exception("failed to initialize sentry")


_init_sentry()


def _validate_runtime_config() -> None:
    if not is_production():
        return

    require_env("AUTH_SECRET_KEY", "JWT_SECRET_KEY")

    raw_origins = [o.strip() for o in (os.getenv("CORS_ORIGINS") or "").split(",") if o.strip()]
    if not raw_origins:
        raise RuntimeError("CORS_ORIGINS must be set in production")
    if any(origin == "*" for origin in raw_origins):
        raise RuntimeError("Wildcard CORS_ORIGINS is not allowed in production")


_validate_runtime_config()

app = FastAPI(title="NEWS")

# GZip responses (helps a lot on slow/cheap hosts)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# ---------- CORS ----------
allowed_origins = [o.strip() for o in (os.getenv("CORS_ORIGINS") or "").split(",") if o.strip()]
if not allowed_origins:
    allowed_origins = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:5173", "http://127.0.0.1:5173"]
allow_credentials = env_bool("CORS_ALLOW_CREDENTIALS", False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=allow_credentials,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            mark_guest(getattr(getattr(request, "client", None), "host", None))
        except Exception:
            app_log.exception("guest tracking failed")

        try:
            csrf_origin_check(request)
        except HTTPException as e:
            return JSONResponse(status_code=e.status_code, content={"detail": e.detail})

        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self' https:; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https:;",
        )
        return response




class DotfileBlockMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = (request.url.path or '').strip()
        normalized = path.lstrip('/')
        first_segment = normalized.split('/', 1)[0] if normalized else ''

        # Never expose dotfiles / repo internals through app routes, SPA fallback,
        # or accidental reverse-proxy passthroughs. Keep /.well-known available.
        if first_segment.startswith('.') and first_segment != '.well-known':
            return Response(status_code=404)
        if normalized.startswith('.git/') or normalized == '.git':
            return Response(status_code=404)
        return await call_next(request)


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        token = request_id_ctx.set(request_id)
        request.state.request_id = request_id
        started = time.perf_counter()
        try:
            response = await call_next(request)
            duration_ms = (time.perf_counter() - started) * 1000.0
            response.headers["X-Request-ID"] = request_id
            level = logging.WARNING if duration_ms >= float(os.getenv("SLOW_REQUEST_MS") or 1500) else logging.INFO
            request_log.log(
                level,
                "request method=%s path=%s status=%s duration_ms=%.2f",
                request.method,
                request.url.path,
                getattr(response, "status_code", "-"),
                duration_ms,
            )
            return response
        except Exception:
            duration_ms = (time.perf_counter() - started) * 1000.0
            request_log.exception(
                "request_failed method=%s path=%s duration_ms=%.2f",
                request.method,
                request.url.path,
                duration_ms,
            )
            raise
        finally:
            request_id_ctx.reset(token)


app.add_middleware(RequestContextMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(DotfileBlockMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    app_log.exception("unhandled_exception path=%s", request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "request_id": getattr(request.state, "request_id", None),
        },
    )


# ---------- Static frontend ----------
app.mount("/static", StaticFiles(directory="src/web"), name="static")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    path = os.path.join("src", "web", "icons", "Logo.svg")
    if os.path.exists(path):
        return FileResponse(path, media_type="image/svg")
    return Response(status_code=404)


# ---------- Routers ----------
app.include_router(health_router)
app.include_router(status_router)
app.include_router(auth_router)
app.include_router(news_router)
app.include_router(interests_router)
app.include_router(alerts_router)
app.include_router(billing_router)
app.include_router(market_router)
app.include_router(widgets_router)
app.include_router(stats_router)
app.include_router(promo_router)
app.include_router(share_router)
app.include_router(image_router)
app.include_router(unsubscribe_router)
app.include_router(report_router)

if not is_production():
    from .routers.debug import router as debug_router
    app.include_router(debug_router)

# ---------- SPA ----------
SPA_TEMPLATE_DIR = Path("src") / "app" / "spa_templates"
SPA_TEMPLATE_FILES = (
    "spa_shell.html",
    "head.html",
    "layout_main.html",
    "overlays.html",
    "assets.html",
)


def _spa_template_mtime_key() -> str:
    mtimes: list[str] = []
    for name in SPA_TEMPLATE_FILES:
        path = SPA_TEMPLATE_DIR / name
        mtimes.append(str(path.stat().st_mtime_ns))
    return "|".join(mtimes)


def _minify_spa_html(html: str) -> str:
    html = re.sub(r"(?s)<!--(?!\[if).*?-->", "", html)
    html = re.sub(r">\s+<", "><", html)
    return html.strip()


@lru_cache(maxsize=4)
def _render_spa_html(_mtime_key: str) -> str:
    shell = (SPA_TEMPLATE_DIR / "spa_shell.html").read_text(encoding="utf-8")
    parts = {
        "HEAD": (SPA_TEMPLATE_DIR / "head.html").read_text(encoding="utf-8").strip(),
        "LAYOUT": (SPA_TEMPLATE_DIR / "layout_main.html").read_text(encoding="utf-8").strip(),
        "OVERLAYS": (SPA_TEMPLATE_DIR / "overlays.html").read_text(encoding="utf-8").strip(),
        "ASSETS": (SPA_TEMPLATE_DIR / "assets.html").read_text(encoding="utf-8").strip(),
    }
    for key, value in parts.items():
        shell = shell.replace(f"{{{{{key}}}}}", value)
    return _minify_spa_html(shell)


def _spa_response() -> HTMLResponse:
    return HTMLResponse(_render_spa_html(_spa_template_mtime_key()))


@app.get("/", include_in_schema=False)
def spa_root():
    return _spa_response()


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str):
    normalized = (full_path or "").strip()
    if normalized.startswith("api/") or normalized.startswith("static/"):
        return Response(status_code=404)
    if normalized in ("favicon.ico",):
        return Response(status_code=404)
    # Never let the SPA fallback expose dotfiles like /.env, /.git, etc.
    first_segment = normalized.split("/", 1)[0] if normalized else ""
    if first_segment.startswith("."):
        return Response(status_code=404)
    return _spa_response()


_auto_task: Optional[asyncio.Task] = None
_notify_task: Optional[asyncio.Task] = None
_fulltext_task: Optional[asyncio.Task] = None
_ingest_lock = asyncio.Lock()


def _env_bool(name: str, default: bool = True) -> bool:
    return env_bool(name, default)


def _get_refresh_interval_seconds() -> int:
    env_val = os.getenv("REFRESH_INTERVAL_SECONDS")
    if env_val:
        try:
            return max(0, int(env_val))
        except Exception:
            app_log.warning("invalid REFRESH_INTERVAL_SECONDS=%r", env_val)

    try:
        cfg = db.get_config()
        v = int(cfg.refresh_interval_seconds or 0)
        if v > 0:
            return v
    except Exception:
        app_log.exception("failed to read refresh interval from db config")

    return 600


async def _fulltext_loop() -> None:
    await asyncio.sleep(3.0)
    while True:
        try:
            if background_tasks_disabled() or not _env_bool("FULLTEXT_WORKER", True):
                await asyncio.sleep(5.0)
                continue

            max_jobs = int(os.getenv("FULLTEXT_MAX_JOBS_PER_TICK", "6") or 6)
            workers = int(os.getenv("FULLTEXT_MAX_WORKERS", "6") or 6)
            await asyncio.to_thread(process_fulltext_queue_once, max_jobs, workers)
            await asyncio.sleep(float(os.getenv("FULLTEXT_TICK_SECONDS", "2") or 2))
        except asyncio.CancelledError:
            break
        except Exception:
            log.exception("fulltext loop failed")
            await asyncio.sleep(5.0)


async def _auto_refresh_loop() -> None:
    await asyncio.sleep(2.0)
    first = True
    while True:
        try:
            enabled = _env_bool("AUTO_REFRESH", True)
            interval = _get_refresh_interval_seconds()
            if background_tasks_disabled() or not enabled or interval <= 0:
                await asyncio.sleep(5.0)
                continue

            if not first:
                await asyncio.sleep(float(interval))
            first = False

            async with _ingest_lock:
                db.ensure_schema()
                await asyncio.to_thread(run_ingest_cycle)
        except asyncio.CancelledError:
            break
        except Exception:
            log.exception("auto refresh failed")
            await asyncio.sleep(10.0)


@app.on_event("startup")
async def _startup_autorefresh() -> None:
    global _auto_task, _fulltext_task, _notify_task
    try:
        db.ensure_schema()
    except Exception:
        log.exception("ensure_schema failed on startup")
    try:
        changed = db.expire_overdue_subscriptions()
        if changed:
            log.info("expired overdue subscriptions on startup changed=%s", changed)
    except Exception:
        log.exception("failed to expire overdue subscriptions on startup")

    if background_tasks_disabled():
        app_log.warning("background tasks are disabled by DISABLE_BACKGROUND_TASKS")
        return

    if _auto_task is None:
        _auto_task = asyncio.create_task(_auto_refresh_loop())
        log.info("auto refresh loop started")
    if _fulltext_task is None:
        _fulltext_task = asyncio.create_task(_fulltext_loop())
        log.info("fulltext loop started")
    if _notify_task is None:
        _notify_task = asyncio.create_task(notify_loop())
        log.info("notify loop started")


@app.on_event("shutdown")
async def _shutdown_autorefresh() -> None:
    global _auto_task, _fulltext_task, _notify_task
    for name, task in (("auto refresh", _auto_task), ("fulltext", _fulltext_task), ("notify", _notify_task)):
        if task is not None:
            task.cancel()
            app_log.info("%s loop stopped", name)
    _auto_task = None
    _fulltext_task = None
    _notify_task = None
