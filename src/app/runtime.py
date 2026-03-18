from __future__ import annotations

import os
from contextvars import ContextVar

request_id_ctx: ContextVar[str] = ContextVar('request_id', default='-')


def env_name() -> str:
    return (os.getenv('APP_ENV') or 'development').strip().lower()


def is_production() -> bool:
    return env_name() in {'prod', 'production'}


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


def background_tasks_disabled() -> bool:
    return env_bool('DISABLE_BACKGROUND_TASKS', False)


def require_env(*names: str) -> str:
    for name in names:
        value = (os.getenv(name) or '').strip()
        if value:
            return value
    raise RuntimeError(f"Missing required environment variable: {' or '.join(names)}")
