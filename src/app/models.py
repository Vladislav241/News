# src/app/models.py
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    db_path: str = "news.db"
    refresh_interval_seconds: int = 900
    rss_sources_json: str = ""
    rss_local_sources_json: str = ""
    newsapi_key: str = ""
    openai_api_key: str = ""
    max_external_requests_per_cycle: int = 60
    refresh_token: str = ""  # optional simple protection for /api/news/refresh
