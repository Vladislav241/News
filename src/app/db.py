from __future__ import annotations

import json
import os
import re
import threading
from functools import lru_cache
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import IntegrityError
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

CORE_INTERESTS = ("business", "technology", "politics", "science", "sports", "health")

def _normalize_interest_selection(interests: list[str] | None) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for raw in (interests or []):
        v = str(raw or "").strip().lower()
        if not v or v in seen:
            continue
        seen.add(v)
        normalized.append(v)

    core = [v for v in normalized if v in CORE_INTERESTS]
    if not core:
        return ["general"]
    return core

def _is_broad_interest_selection(interests: list[str] | None) -> bool:
    normalized = [v for v in _normalize_interest_selection(interests) if v != "general"]
    return not normalized or all(v in normalized for v in CORE_INTERESTS)


from .models import AppConfig
from .sources import normalize_source_key

# -----------------
# PostgreSQL wrapper (psycopg2) that mimics a tiny subset of _PGConn/Cursor
# so the rest of the codebase can stay mostly unchanged.
# -----------------

def _sql_qmark_to_percent(sql: str) -> str:
    """Convert SQLite-style '?' placeholders to psycopg2 '%s' outside of string literals."""
    out = []
    in_single = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        if ch == "'":
            if in_single and i + 1 < len(sql) and sql[i + 1] == "'":
                out.append("''")
                i += 2
                continue
            in_single = not in_single
            out.append(ch)
            i += 1
            continue
        if (not in_single) and ch == "?":
            out.append("%s")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)

def _adapt_sqlite_dialect(sql: str) -> str:
    s = sql.strip().rstrip(";")
    if re.match(r"(?is)^insert\s+or\s+ignore\s+into\b", s):
        s = re.sub(r"(?is)^insert\s+or\s+ignore\s+into\b", "INSERT INTO", s)
        if "on conflict" not in s.lower():
            s = s + " ON CONFLICT DO NOTHING"
    return _sql_qmark_to_percent(s)


@lru_cache(maxsize=1)
def _get_local_source_matchers() -> dict[str, dict[str, tuple[str, ...]]]:
    """Parse RSS_LOCAL_SOURCES_JSON into SQL-friendly country matchers.

    This is used as a production-safe fallback when legacy rows in the DB were
    inserted before country-scoped clustering was enabled. In that case the
    article/cluster may still say `world`, but the outlet itself clearly belongs
    to the selected local feed (e.g. Spiegel/Daily Mail/LA Times).
    """
    raw = (os.getenv("RSS_LOCAL_SOURCES_JSON", "") or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}

    out: dict[str, dict[str, tuple[str, ...]]] = {}
    for country, by_lang in data.items():
        ckey = (str(country or "").strip().lower() or "world")
        if ckey == "world" or not isinstance(by_lang, dict):
            continue
        source_keys: set[str] = set()
        source_names: set[str] = set()
        hosts: set[str] = set()
        for _, by_topic in by_lang.items():
            if not isinstance(by_topic, dict):
                continue
            for _, items in by_topic.items():
                for item in (items or []):
                    if not isinstance(item, dict):
                        continue
                    name = (str(item.get("name") or "").strip())
                    url = (str(item.get("url") or "").strip())
                    if name:
                        source_names.add(name.lower())
                        source_keys.add(normalize_source_key(name))
                    if url:
                        try:
                            host = (urlparse(url).netloc or "").strip().lower()
                        except Exception:
                            host = ""
                        if host.startswith("www."):
                            host = host[4:]
                        if host:
                            hosts.add(host)
        out[ckey] = {
            "source_keys": tuple(sorted(source_keys)),
            "source_names": tuple(sorted(source_names)),
            "hosts": tuple(sorted(hosts)),
        }
    return out


def _append_local_source_exists(where: list[str], params: list[Any], country: str) -> None:
    matchers = _get_local_source_matchers().get((country or "").strip().lower()) or {}
    source_keys = list(matchers.get("source_keys") or ())
    source_names = list(matchers.get("source_names") or ())
    hosts = list(matchers.get("hosts") or ())

    local_parts: list[str] = [
        "c.country=?",
        """EXISTS (
            SELECT 1
            FROM cluster_articles ca
            JOIN articles a ON a.id = ca.article_id
            WHERE ca.cluster_id = c.id
              AND LOWER(COALESCE(a.country, '')) = ?
        )""",
    ]
    local_params: list[Any] = [country, country]

    if source_keys:
        placeholders = ",".join("?" for _ in source_keys)
        local_parts.append(
            f"""EXISTS (
                SELECT 1
                FROM cluster_articles ca
                JOIN articles a ON a.id = ca.article_id
                WHERE ca.cluster_id = c.id
                  AND LOWER(COALESCE(a.source_key, '')) IN ({placeholders})
            )"""
        )
        local_params.extend(source_keys)

    if source_names:
        placeholders = ",".join("?" for _ in source_names)
        local_parts.append(
            f"""EXISTS (
                SELECT 1
                FROM cluster_articles ca
                JOIN articles a ON a.id = ca.article_id
                WHERE ca.cluster_id = c.id
                  AND LOWER(COALESCE(a.source_name, '')) IN ({placeholders})
            )"""
        )
        local_params.extend(source_names)

    if hosts:
        host_checks = " OR ".join(["LOWER(COALESCE(a.url, '')) LIKE ?" for _ in hosts])
        local_parts.append(
            f"""EXISTS (
                SELECT 1
                FROM cluster_articles ca
                JOIN articles a ON a.id = ca.article_id
                WHERE ca.cluster_id = c.id
                  AND ({host_checks})
            )"""
        )
        local_params.extend([f"%{h}%" for h in hosts])

    where.append("(" + " OR ".join(local_parts) + ")")
    params.extend(local_params)


def _append_cluster_or_article_language(where: list[str], params: list[Any], languages: list[str]) -> None:
    langs = [str(x or "").strip().lower() for x in (languages or []) if str(x or "").strip()]
    if not langs:
        return

    placeholders = ",".join("?" for _ in langs)
    where.append(
        f"""(
            LOWER(COALESCE(c.language, '')) IN ({placeholders})
            OR EXISTS (
                SELECT 1
                FROM cluster_articles ca
                JOIN articles a ON a.id = ca.article_id
                WHERE ca.cluster_id = c.id
                  AND LOWER(COALESCE(a.language, '')) IN ({placeholders})
            )
        )"""
    )
    params.extend(langs)
    params.extend(langs)

class _PGCursor:
    def __init__(self, cur) -> None:
        self._cur = cur

    @property
    def rowcount(self) -> int:
        return getattr(self._cur, "rowcount", -1)

    def fetchone(self):
        row = self._cur.fetchone()
        try:
            self._cur.close()
        except Exception:
            pass
        return row

    def fetchall(self):
        rows = self._cur.fetchall()
        try:
            self._cur.close()
        except Exception:
            pass
        return rows

class _PGConn:
    def __init__(self, raw_conn, lock: threading.RLock):
        self._raw = raw_conn
        self._lock = lock

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        with self._lock:
            if getattr(self._raw, "closed", 1):
                return False
            if exc_type is None:
                self._raw.commit()
            else:
                self._raw.rollback()
        return False

    def execute(self, sql, params=None):
        cur = self._raw.cursor(cursor_factory=psycopg2.extras.DictCursor)
        try:
            cur.execute(_adapt_sqlite_dialect(sql), params or ())
            return cur
        except Exception:
            try:
                self._raw.rollback()
            except Exception:
                pass
            try:
                cur.close()
            except Exception:
                pass
            raise



    def executemany(self, sql: str, seq_of_params):
        with self._lock:
            cur = self._raw.cursor()
            cur.executemany(_adapt_sqlite_dialect(sql), seq_of_params)
            try:
                cur.close()
            except Exception:
                pass
            return cur

    def commit(self):
        with self._lock:
            self._raw.commit()

    @property
    def closed(self):
        return getattr(self._raw, "closed", 1)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _utc_days_ago_iso(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.replace(microsecond=0).isoformat()


class Database:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._raw_conn = None   # <-- ДОДАЙ ОЦЕ
        self._conn: Optional[_PGConn] = None


    @property
    def conn(self) -> _PGConn:
        if self._conn is None:
            raise RuntimeError("Database is not connected. Set DATABASE_URL and call db.connect() first.")
        return self._conn

    def get_config(self) -> AppConfig:
        return AppConfig(
            db_path=os.getenv("DB_PATH", "news.db"),
            refresh_interval_seconds=int(os.getenv("REFRESH_INTERVAL_SECONDS", "900")),
            rss_sources_json=os.getenv("RSS_SOURCES_JSON", "").strip(),
            rss_local_sources_json=os.getenv("RSS_LOCAL_SOURCES_JSON", "").strip(),
            newsapi_key=os.getenv("NEWSAPI_KEY", "").strip(),
            openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
            max_external_requests_per_cycle=int(os.getenv("MAX_EXTERNAL_REQUESTS_PER_CYCLE", "60")),
            refresh_token=os.getenv("REFRESH_TOKEN", "").strip(),
        )


    def connect(self) -> _PGConn:
        dsn = (os.getenv("DATABASE_URL") or "").strip()
        if not dsn:
            raise RuntimeError(
                "DATABASE_URL is not set. Configure PostgreSQL and set DATABASE_URL like "
                "'postgresql://user:pass@host:5432/dbname'."
            )
        with self._lock:
            if self._raw_conn is None or getattr(self._raw_conn, "closed", 1):
                self._raw_conn = psycopg2.connect(dsn)
                self._raw_conn.autocommit = True
                self._conn = _PGConn(self._raw_conn, self._lock)

            return self._conn


    def _has_column(self, table: str, col: str) -> bool:
        conn = self.connect()
        row = conn.execute(
            """
            SELECT 1 AS x
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ? AND column_name = ?
            LIMIT 1
            """,
            (table, col),
        ).fetchone()
        return bool(row)


    def ensure_schema(self) -> None:
        conn = self.connect()
        with self._lock:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS articles (
                    id BIGSERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    url_hash TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    source_key TEXT,
                    published_at TEXT,
                    content TEXT,
                    description TEXT,
                    raw_json TEXT,
                    topic TEXT,
                    country TEXT,
                    language TEXT,
                    image_url TEXT,
                    needs_fulltext INTEGER NOT NULL DEFAULT 0,
                    fulltext_status TEXT,
                    fulltext_attempts INTEGER NOT NULL DEFAULT 0,
                    fulltext_next_attempt_at TEXT,
                    fulltext_error TEXT,
                    fulltext_updated_at TEXT,
                    inserted_at TEXT NOT NULL
                );
                """
            )
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url_hash ON articles(url_hash);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS clusters (
                    id BIGSERIAL PRIMARY KEY,
                    cluster_key TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    topic TEXT,
                    country TEXT,
                    language TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters(updated_at);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clusters_lang ON clusters(language);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clusters_country ON clusters(country);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clusters_topic ON clusters(topic);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cluster_articles (
                    cluster_id BIGINT NOT NULL,
                    article_id BIGINT NOT NULL,
                    inserted_at TEXT NOT NULL,
                    PRIMARY KEY (cluster_id, article_id),
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
                    FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cluster_articles_article ON cluster_articles(article_id);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS article_scores (
                    cluster_id BIGINT PRIMARY KEY,
                    credibility_score INTEGER NOT NULL,
                    score_details_json TEXT NOT NULL,
                    computed_at TEXT NOT NULL,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS article_summaries (
                    cluster_id BIGINT PRIMARY KEY,
                    summary_text TEXT,
                    summary_json TEXT,
                    raw_text TEXT,
                    model TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    source_fingerprint TEXT,
                    source_count INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )

            # Backwards-compatible summary metadata columns used to avoid re-summarizing
            # the same cluster sources on every ingest cycle.
            conn.execute("ALTER TABLE article_summaries ADD COLUMN IF NOT EXISTS source_fingerprint TEXT;")
            conn.execute("ALTER TABLE article_summaries ADD COLUMN IF NOT EXISTS source_count INTEGER NOT NULL DEFAULT 0;")

            # --- Trust score history (server-side) ---
            # Stores score snapshots for a cluster over time so the UI can render a stable chart
            # across devices and sessions.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS trust_score_history (
                    id BIGSERIAL PRIMARY KEY,
                    cluster_id BIGINT NOT NULL,
                    score INTEGER NOT NULL,
                    sources_count INTEGER NOT NULL,
                    sources_delta INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_trust_history_cluster_time ON trust_score_history(cluster_id, created_at);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ingest_runs (
                    id BIGSERIAL PRIMARY KEY,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    status TEXT NOT NULL,
                    stats_json TEXT NOT NULL
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_pair_cache (
                    cache_key TEXT PRIMARY KEY,
                    cache_kind TEXT NOT NULL,
                    model TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_llm_pair_cache_expires ON llm_pair_cache(expires_at);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_usage_events (
                    id BIGSERIAL PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    feature TEXT NOT NULL,
                    model TEXT,
                    status TEXT NOT NULL,
                    cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
                    latency_ms INTEGER,
                    prompt_tokens INTEGER,
                    completion_tokens INTEGER,
                    total_tokens INTEGER,
                    meta_json TEXT
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created ON ai_usage_events(created_at);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_usage_events_feature_created ON ai_usage_events(feature, created_at);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS favorites (
                    device_id TEXT NOT NULL,
                    cluster_id BIGINT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_score INTEGER,
                    last_seen_sources_count INTEGER,
                    last_seen_at TEXT,
                    PRIMARY KEY (device_id, cluster_id),
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_favorites_cluster ON favorites(cluster_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_favorites_device ON favorites(device_id);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS feed_health (
                    feed_url TEXT PRIMARY KEY,
                    feed_name TEXT,
                    etag TEXT,
                    last_modified TEXT,
                    last_ok_at TEXT,
                    last_error_at TEXT,
                    last_error TEXT,
                    error_count INTEGER NOT NULL DEFAULT 0,
                    backoff_until TEXT
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id BIGSERIAL PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    hashed_password TEXT,
                    email_verified INTEGER NOT NULL DEFAULT 0,
                    provider TEXT NOT NULL DEFAULT 'local',
                    provider_id TEXT,
                    stripe_customer_id TEXT,
                    full_name TEXT,
                    picture_url TEXT,
                    created_at TEXT NOT NULL,
                    last_login TEXT
                );
                """
            )
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);")

            # Online/admin stats support.
            # Keep timestamps as ISO strings to stay compatible with both sqlite and postgres.
            try:
                conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT;")
            except Exception:
                pass

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_tokens (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    token_type TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    consumed_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_auth_tokens_type ON auth_tokens(token_type);")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_favorites (
                    user_id BIGINT NOT NULL,
                    cluster_id BIGINT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_score INTEGER,
                    last_seen_sources_count INTEGER,
                    last_seen_at TEXT,
                    email_alerts_enabled INTEGER NOT NULL DEFAULT 0,
                    last_notified_score INTEGER,
                    last_notified_sources_count INTEGER,
                    last_notified_at TEXT,
                    last_notified_fingerprint TEXT,
                    PRIMARY KEY (user_id, cluster_id),
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_user_favs_user ON user_favorites(user_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_user_favs_cluster ON user_favorites(cluster_id);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_subscriptions (
                    user_id BIGINT PRIMARY KEY,
                    plan TEXT NOT NULL DEFAULT 'free',
                    status TEXT NOT NULL DEFAULT 'active',
                    billing_interval TEXT NOT NULL DEFAULT 'monthly',
                    stripe_customer_id TEXT,
                    stripe_subscription_id TEXT,
                    current_period_end TEXT,
                    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_user_subs_plan ON user_subscriptions(plan);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS visual_search_usage (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    searched_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_visual_search_usage_user_time ON visual_search_usage(user_id, searched_at);")

            # Account-scoped UI/preferences (e.g., interests) so settings persist across devices.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id BIGINT PRIMARY KEY,
                    interests_json TEXT,
                    country TEXT,
                    language TEXT,
                    ui_json TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_user_prefs_updated ON user_preferences(updated_at);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS share_promo_attempts (
                    id BIGSERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    cluster_id BIGINT NOT NULL,
                    platform TEXT NOT NULL,
                    share_token TEXT NOT NULL UNIQUE,
                    article_url TEXT NOT NULL,
                    share_url TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'started',
                    post_url TEXT,
                    verify_detail TEXT,
                    created_at TEXT NOT NULL,
                    submitted_at TEXT,
                    confirmed_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_share_promo_user_status ON share_promo_attempts(user_id, status);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_share_promo_user_cluster ON share_promo_attempts(user_id, cluster_id);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS share_promo_rewards (
                    user_id BIGINT PRIMARY KEY,
                    plan TEXT NOT NULL DEFAULT 'pro',
                    source TEXT NOT NULL DEFAULT 'share_campaign',
                    starts_at TEXT NOT NULL,
                    ends_at TEXT NOT NULL,
                    granted_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """
            )

            # Lightweight migration for older installs: add cancel_at_period_end if missing.
            try:
                conn.execute(
                    "ALTER TABLE user_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE"
                )
            except Exception:
                # Column likely already exists.
                pass

            # Lightweight migration for older installs: add ui_json to user_preferences if missing.
            try:
                conn.execute(
                    "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS ui_json TEXT"
                )
            except Exception:
                pass

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS text_translations (
                    id BIGSERIAL PRIMARY KEY,
                    scope TEXT NOT NULL,
                    scope_id BIGINT NOT NULL,
                    field TEXT NOT NULL,
                    target_lang TEXT NOT NULL,
                    src_hash TEXT NOT NULL,
                    translated TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(scope, scope_id, field, target_lang, src_hash)
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_text_trans_scope ON text_translations(scope, scope_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_text_trans_lang ON text_translations(target_lang);")

            # Video Report cache (YouTube search results)
            # cache_key is a deterministic hash of (query, lang, etc.)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS video_report_cache (
                    cache_key TEXT PRIMARY KEY,
                    q TEXT NOT NULL,
                    lang TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expires_at TEXT NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_video_report_cache_expires ON video_report_cache(expires_at);")
            
            # --- Media Bias widget tables ---
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS source_bias (
                    domain TEXT PRIMARY KEY,
                    bias TEXT NOT NULL,
                    confidence REAL NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'unknown',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_source_bias_bias ON source_bias(bias);")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS media_bias_cache (
                    cache_key TEXT PRIMARY KEY,
                    cluster_id BIGINT NOT NULL,
                    cluster_updated_at TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expires_at TEXT NOT NULL
                );
                """
            )
            if not self._has_column("media_bias_cache", "cluster_updated_at"):
                conn.execute("ALTER TABLE media_bias_cache ADD COLUMN cluster_updated_at TEXT;")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_media_bias_cache_expires ON media_bias_cache(expires_at);")
        conn.commit()

    def get_user_subscription(self, user_id: int) -> Optional[dict[str, Any]]:
        conn = self.connect()
        row = conn.execute(
            "SELECT * FROM user_subscriptions WHERE user_id = ?",
            (int(user_id),),
        ).fetchone()
        if row and self._is_subscription_overdue(dict(row)):
            self.expire_overdue_subscriptions(int(user_id))
            row = conn.execute(
                "SELECT * FROM user_subscriptions WHERE user_id = ?",
                (int(user_id),),
            ).fetchone()

        # Active promotional rewards (e.g. share campaign) should behave like a real Pro plan
        # across all feature gates, but must not override a paid Pro/Analyst subscription.
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        reward = conn.execute(
            "SELECT * FROM share_promo_rewards WHERE user_id = ? AND ends_at > ?",
            (int(user_id), now),
        ).fetchone()

        if row:
            plan = str(row.get("plan") or "free").strip().lower()
            status = str(row.get("status") or "active").strip().lower()
            if plan in ("pro", "analyst") and status in ("active", "trialing"):
                return row
            if reward:
                out = dict(row)
                out["plan"] = str(reward.get("plan") or "pro")
                out["status"] = "active"
                out["billing_interval"] = "promo"
                out["current_period_end"] = reward.get("ends_at")
                out["cancel_at_period_end"] = True
                out["promo_source"] = reward.get("source") or "share_campaign"
                return out
            if plan in ("pro", "analyst") and status not in ("active", "trialing"):
                out = dict(row)
                out["previous_plan"] = plan
                out["plan"] = "free"
                out["status"] = "expired"
                out["billing_interval"] = "monthly"
                out["cancel_at_period_end"] = False
                return out
            return row

        if reward:
            return {
                "user_id": int(user_id),
                "plan": str(reward.get("plan") or "pro"),
                "status": "active",
                "billing_interval": "promo",
                "stripe_customer_id": None,
                "stripe_subscription_id": None,
                "current_period_end": reward.get("ends_at"),
                "cancel_at_period_end": True,
                "created_at": reward.get("granted_at"),
                "updated_at": reward.get("updated_at"),
                "promo_source": reward.get("source") or "share_campaign",
            }
        return None

    def _is_subscription_overdue(self, sub: Optional[dict[str, Any]]) -> bool:
        if not sub:
            return False
        plan = str((sub.get("plan") or "free")).strip().lower()
        if plan not in ("pro", "analyst"):
            return False
        status = str((sub.get("status") or "")).strip().lower()
        if status in ("expired", "free"):
            return False
        current_period_end = sub.get("current_period_end")
        if not current_period_end:
            return False
        try:
            ends_at = datetime.fromisoformat(str(current_period_end).replace("Z", "+00:00"))
            if ends_at.tzinfo is None:
                ends_at = ends_at.replace(tzinfo=timezone.utc)
        except Exception:
            return False
        should_end = bool(sub.get("cancel_at_period_end")) or status in ("canceled", "incomplete_expired", "unpaid")
        return should_end and ends_at <= datetime.now(timezone.utc)

    def expire_overdue_subscriptions(self, user_id: Optional[int] = None) -> int:
        conn = self.connect()
        rows = []
        if user_id is None:
            rows = conn.execute("SELECT * FROM user_subscriptions WHERE plan IN ('pro','analyst')").fetchall() or []
        else:
            rows = conn.execute("SELECT * FROM user_subscriptions WHERE user_id = ? AND plan IN ('pro','analyst')", (int(user_id),)).fetchall() or []
        overdue_ids: list[int] = []
        for row in rows:
            item = dict(row)
            if self._is_subscription_overdue(item):
                overdue_ids.append(int(item.get("user_id")))
        if not overdue_ids:
            return 0
        now = _utc_now_iso()
        with self._lock:
            for uid in overdue_ids:
                conn.execute(
                    """
                    UPDATE user_subscriptions
                    SET plan = 'free',
                        status = 'expired',
                        billing_interval = 'monthly',
                        stripe_subscription_id = NULL,
                        cancel_at_period_end = FALSE,
                        updated_at = ?
                    WHERE user_id = ?
                    """,
                    (now, int(uid)),
                )
            conn.commit()
        return len(overdue_ids)

    def create_share_promo_attempt(self, user_id: int, cluster_id: int, platform: str, share_token: str, article_url: str, share_url: str) -> dict[str, Any]:
        conn = self.connect()
        now = _utc_now_iso()
        row = conn.execute(
            """
            INSERT INTO share_promo_attempts
            (user_id, cluster_id, platform, share_token, article_url, share_url, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'started', ?)
            RETURNING *
            """,
            (int(user_id), int(cluster_id), str(platform), str(share_token), str(article_url), str(share_url), now),
        ).fetchone()
        conn.commit()
        return dict(row)

    def get_share_promo_attempt(self, attempt_id: int, user_id: int) -> Optional[dict[str, Any]]:
        return self._fetchone(
            "SELECT * FROM share_promo_attempts WHERE id = ? AND user_id = ?",
            (int(attempt_id), int(user_id)),
        )

    def update_share_promo_attempt_submission(self, attempt_id: int, user_id: int, post_url: str, status: str, verify_detail: str, confirmed: bool = False) -> Optional[dict[str, Any]]:
        conn = self.connect()
        now = _utc_now_iso()
        confirmed_at = now if confirmed else None
        row = conn.execute(
            """
            UPDATE share_promo_attempts
            SET post_url = ?, status = ?, verify_detail = ?, submitted_at = ?, confirmed_at = COALESCE(?, confirmed_at)
            WHERE id = ? AND user_id = ?
            RETURNING *
            """,
            (str(post_url), str(status), str(verify_detail or ''), now, confirmed_at, int(attempt_id), int(user_id)),
        ).fetchone()
        conn.commit()
        return dict(row) if row else None

    def get_share_promo_progress(self, user_id: int) -> dict[str, Any]:
        uid = int(user_id)
        counts = self._fetchone(
            """
            SELECT
              COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_attempts,
              COUNT(DISTINCT CASE WHEN status = 'confirmed' THEN cluster_id END) AS confirmed_unique_clusters,
              COUNT(*) FILTER (WHERE status IN ('started','submitted','rejected')) AS pending_attempts
            FROM share_promo_attempts
            WHERE user_id = ?
            """,
            (uid,),
        ) or {}
        now = _utc_now_iso()
        reward = self._fetchone("SELECT * FROM share_promo_rewards WHERE user_id = ? AND ends_at > ?", (uid, now))
        return {
            "confirmed_attempts": int(counts.get("confirmed_attempts") or 0),
            "confirmed_unique_clusters": int(counts.get("confirmed_unique_clusters") or 0),
            "pending_attempts": int(counts.get("pending_attempts") or 0),
            "reward": reward,
        }

    def grant_share_promo_reward(self, user_id: int, plan: str, starts_at: str, ends_at: str, source: str = 'share_campaign') -> dict[str, Any]:
        conn = self.connect()
        now = _utc_now_iso()
        row = conn.execute(
            """
            INSERT INTO share_promo_rewards(user_id, plan, source, starts_at, ends_at, granted_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE
            SET plan = EXCLUDED.plan,
                source = EXCLUDED.source,
                starts_at = EXCLUDED.starts_at,
                ends_at = EXCLUDED.ends_at,
                updated_at = EXCLUDED.updated_at
            RETURNING *
            """,
            (int(user_id), str(plan), str(source), str(starts_at), str(ends_at), now, now),
        ).fetchone()
        conn.commit()
        return dict(row)

    def set_user_subscription(
        self,
        user_id: int,
        plan: str,
        status: str = "active",
        billing_interval: str = "monthly",
        stripe_customer_id: Optional[str] = None,
        stripe_subscription_id: Optional[str] = None,
        current_period_end: Optional[str] = None,
        cancel_at_period_end: bool = False,
    ) -> None:
        """Upsert subscription row."""
        conn = self.connect()
        now = _utc_now_iso()
        with self._lock:
            existing = self.get_user_subscription(user_id)
            if existing:
                conn.execute(
                    """
                    UPDATE user_subscriptions
                    SET plan = ?, status = ?, billing_interval = ?,
                        stripe_customer_id = COALESCE(?, stripe_customer_id),
                        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                        current_period_end = COALESCE(?, current_period_end),
                        cancel_at_period_end = ?,
                        updated_at = ?
                    WHERE user_id = ?
                    """,
                    (
                        plan,
                        status,
                        billing_interval,
                        stripe_customer_id,
                        stripe_subscription_id,
                        current_period_end,
                       bool(cancel_at_period_end),
                        now,
                        int(user_id),
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO user_subscriptions
                    (user_id, plan, status, billing_interval, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        int(user_id),
                        plan,
                        status,
                        billing_interval,
                        stripe_customer_id,
                        stripe_subscription_id,
                        current_period_end,
                        bool(cancel_at_period_end),
                        now,
                        now,
                    ),
                )
            conn.commit()

    def set_user_stripe_customer_id(self, user_id: int, stripe_customer_id: str) -> None:
        conn = self.connect()
        with self._lock:
            conn.execute("UPDATE users SET stripe_customer_id = ? WHERE id = ?", (stripe_customer_id, int(user_id)))
            conn.commit()

    def get_visual_search_limit_for_plan(self, plan: str | None) -> Optional[int]:
        p = str(plan or "free").strip().lower()
        if p == "analyst":
            return None
        if p == "pro":
            return 10
        return 3

    def get_visual_search_quota(self, user_id: int, plan: str | None = None) -> dict[str, Any]:
        uid = int(user_id)
        effective_plan = str(plan or (self.get_user_subscription(uid) or {}).get("plan") or "free").strip().lower()
        limit = self.get_visual_search_limit_for_plan(effective_plan)
        now_dt = datetime.now(timezone.utc)
        now_iso = now_dt.isoformat()
        window_start_dt = now_dt - timedelta(hours=24)
        window_start_iso = window_start_dt.isoformat()

        rows = self._fetchall(
            "SELECT searched_at FROM visual_search_usage WHERE user_id = ? AND searched_at >= ? ORDER BY searched_at ASC",
            (uid, window_start_iso),
        )
        used = len(rows)
        remaining = None if limit is None else max(0, int(limit) - used)
        reset_at = None
        retry_after_seconds = 0
        locked = False

        if limit is not None and used >= int(limit):
            locked = True
            oldest = str(rows[0].get("searched_at") or "") if rows else ""
            try:
                oldest_dt = datetime.fromisoformat(oldest.replace("Z", "+00:00"))
                if oldest_dt.tzinfo is None:
                    oldest_dt = oldest_dt.replace(tzinfo=timezone.utc)
                reset_dt = oldest_dt + timedelta(hours=24)
                reset_at = reset_dt.isoformat()
                retry_after_seconds = max(0, int((reset_dt - now_dt).total_seconds()))
            except Exception:
                reset_at = None
                retry_after_seconds = 0
        elif rows:
            try:
                oldest_dt = datetime.fromisoformat(str(rows[0].get("searched_at") or "").replace("Z", "+00:00"))
                if oldest_dt.tzinfo is None:
                    oldest_dt = oldest_dt.replace(tzinfo=timezone.utc)
                reset_at = (oldest_dt + timedelta(hours=24)).isoformat()
            except Exception:
                reset_at = None

        return {
            "plan": effective_plan,
            "limit": limit,
            "used": int(used),
            "remaining": remaining,
            "locked": bool(locked),
            "window_hours": 24,
            "retry_after_seconds": int(retry_after_seconds),
            "reset_at": reset_at,
            "checked_at": now_iso,
        }

    def record_visual_search_usage(self, user_id: int, searched_at: Optional[str] = None) -> dict[str, Any]:
        uid = int(user_id)
        ts = str(searched_at or _utc_now_iso())
        conn = self.connect()
        with self._lock:
            row = conn.execute(
                """
                INSERT INTO visual_search_usage(user_id, searched_at, created_at)
                VALUES (?, ?, ?)
                RETURNING *
                """,
                (uid, ts, ts),
            ).fetchone()
            try:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
                conn.execute("DELETE FROM visual_search_usage WHERE searched_at < ?", (cutoff,))
            except Exception:
                pass
            conn.commit()
        return dict(row) if row else {"user_id": uid, "searched_at": ts, "created_at": ts}

    # --------- helpers ----------
    def _exec(self, sql: str, params: tuple[Any, ...] = ()) -> _PGCursor:
        conn = self.connect()
        return conn.execute(sql, params)

    def _fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> Optional[dict[str, Any]]:
        conn = self.connect()
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def _fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        conn = self.connect()
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in (rows or [])]

    def start_ingest_run(self) -> int:
        row = self._fetchone(
            "INSERT INTO ingest_runs(started_at, status, stats_json) VALUES(?, ?, ?) RETURNING id",
            (_utc_now_iso(), "running", json.dumps({})),
        )
        return int(row["id"]) if row else 0

    def finish_ingest_run(self, run_id: int, status: str, stats: dict[str, Any]) -> None:
        self._exec(
            "UPDATE ingest_runs SET finished_at=?, status=?, stats_json=? WHERE id=?",
            (_utc_now_iso(), status, json.dumps(stats, ensure_ascii=False), run_id),
        )

    def get_last_ingest_run(self) -> Optional[dict[str, Any]]:
        return self._fetchone("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1")

    # --------- articles ----------
    def insert_article_if_new(self, article: dict[str, Any]) -> Optional[int]:
        url = (article.get("url") or "").strip()
        if not url:
            return None
        url_hash = (article.get("url_hash") or "").strip()
        if not url_hash:
            return None

        src_name = (article.get("source_name") or "unknown").strip()
        src_key = (article.get("source_key") or "").strip() or normalize_source_key(src_name)

        title = (article.get("title") or "").strip()
        published_at = (article.get("published_at") or "").strip() or None
        content = (article.get("content") or "").strip() or None
        description = (article.get("description") or "").strip() or None
        raw_json = json.dumps(article.get("raw_json") or {}, ensure_ascii=False)
        topic = (article.get("topic") or "").strip() or None
        country = (article.get("country") or "").strip() or None
        language = (article.get("language") or "").strip() or None
        image_url = (article.get("image_url") or "").strip() or None
        needs_fulltext = 1 if int(article.get("needs_fulltext") or 0) else 0

        cur = self._exec(
            """
            INSERT INTO articles(
                title, url, url_hash, source_name, source_key, published_at,
                content, description, raw_json, topic, country, language,
                image_url, needs_fulltext, inserted_at,
                fulltext_status, fulltext_attempts, fulltext_next_attempt_at, fulltext_error, fulltext_updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (url_hash) DO NOTHING
            RETURNING id
            """,
            (
                title, url, url_hash, src_name, src_key, published_at,
                content, description, raw_json, topic, country, language,
                image_url, needs_fulltext, _utc_now_iso(),
                None, 0, None, None, None
            ),
        )
        row = cur.fetchone()
        return int(row["id"]) if row else None

    def get_article_by_id(self, article_id: int) -> dict[str, Any]:
        row = self._fetchone("SELECT * FROM articles WHERE id=?", (article_id,))
        return row or {}

    def update_article_image_url(self, article_id: int, image_url: str) -> None:
        self._exec("UPDATE articles SET image_url=? WHERE id=?", (image_url, int(article_id)))

    # --------- fulltext queue ----------
    def list_fulltext_pending(self, limit: int = 25) -> list[dict[str, Any]]:
        """Articles that need fulltext extraction and are ready to be retried."""
        limit = int(max(1, min(200, limit)))
        now = _utc_now_iso()
        rows = self._fetchall(
            """
            SELECT id, url, source_name, description, content, fulltext_attempts
            FROM articles
            WHERE needs_fulltext=1
              AND (fulltext_status IS NULL OR fulltext_status IN ('pending','failed'))
              AND (fulltext_next_attempt_at IS NULL OR fulltext_next_attempt_at <= ?)
            ORDER BY inserted_at DESC
            LIMIT ?
            """,
            (now, limit),
        )
        return rows or []

    def claim_fulltext_job(self, article_id: int) -> bool:
        """Mark a job as in_progress if it's still pending."""
        cur = self._exec(
            """
            UPDATE articles
            SET fulltext_status='in_progress', fulltext_updated_at=?
            WHERE id=? AND needs_fulltext=1 AND (fulltext_status IS NULL OR fulltext_status IN ('pending','failed'))
            """,
            (_utc_now_iso(), int(article_id)),
        )
        return bool(cur.rowcount)

    def mark_fulltext_done(self, article_id: int, description: str, content: str) -> None:
        self._exec(
            """
            UPDATE articles
            SET description=?, content=?, needs_fulltext=0,
                fulltext_status='done', fulltext_error=NULL,
                fulltext_updated_at=?, fulltext_next_attempt_at=NULL
            WHERE id=?
            """,
            ((description or None), (content or None), _utc_now_iso(), int(article_id)),
        )

    def mark_fulltext_failed(self, article_id: int, error: str, backoff_seconds: int) -> None:
        # basic exponential backoff
        art = self.get_article_by_id(int(article_id))
        attempts = int(art.get('fulltext_attempts') or 0) + 1
        # cap next retry
        from datetime import timedelta
        next_at = (datetime.now(timezone.utc) + timedelta(seconds=int(backoff_seconds))).replace(microsecond=0).isoformat()
        self._exec(
            """
            UPDATE articles
            SET fulltext_status='failed', fulltext_attempts=?, fulltext_error=?,
                fulltext_next_attempt_at=?, fulltext_updated_at=?
            WHERE id=?
            """,
            (attempts, (error or '')[:800], next_at, _utc_now_iso(), int(article_id)),
        )

    # --------- clusters ----------
    def upsert_cluster(self, cluster_key: str, title: str, topic: str, country: str, language: str) -> int:
        existing = self._fetchone("SELECT id FROM clusters WHERE cluster_key=?", (cluster_key,))
        now = _utc_now_iso()
        if existing:
            cid = int(existing["id"])
            self._exec(
                "UPDATE clusters SET title=?, topic=?, country=?, language=?, updated_at=? WHERE id=?",
                (title, topic, country, language, now, cid),
            )
            return cid
        cur = self._exec(
            """
            INSERT INTO clusters(cluster_key, title, topic, country, language, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING id
            """,
            (cluster_key, title, topic, country, language, now, now),
        )
        row = cur.fetchone()
        return int(row["id"]) if row else 0

    def touch_cluster(self, cluster_id: int) -> None:
        self._exec("UPDATE clusters SET updated_at=? WHERE id=?", (_utc_now_iso(), cluster_id))

    def link_cluster_article(self, cluster_id: int, article_id: int) -> bool:
        try:
            self._exec(
                "INSERT INTO cluster_articles(cluster_id, article_id, inserted_at) VALUES(?, ?, ?)",
                (cluster_id, article_id, _utc_now_iso()),
            )
            self.touch_cluster(cluster_id)
            return True
        except IntegrityError:
            return False

    def list_recent_clusters(self, language: str, country: str | None = None, limit: int = 600) -> list[dict[str, Any]]:
        language = (language or "").strip().lower()
        country = (country or "").strip().lower()

        sql = """
            SELECT id, cluster_key, title, topic, country, language, created_at, updated_at
            FROM clusters
            WHERE language=?
        """
        params: list[Any] = [language]

        if country:
            # Backward-compatible country scoping:
            # - prefer the cluster's own country flag for new rows
            # - but also include older clusters that were created before
            #   regional clustering was isolated, as long as they contain
            #   at least one article from the requested country.
            sql += """
              AND (
                    country=?
                    OR EXISTS (
                        SELECT 1
                        FROM cluster_articles ca
                        JOIN articles a ON a.id = ca.article_id
                        WHERE ca.cluster_id = clusters.id
                          AND LOWER(COALESCE(a.country, '')) = ?
                    )
              )
            """
            params.extend([country, country])

        sql += """
            ORDER BY updated_at DESC
            LIMIT ?
        """
        params.append(limit)
        return self._fetchall(sql, tuple(params))

    def get_cluster_article_texts(self, cluster_id: int, limit: int = 12) -> list[str]:
        rows = self._fetchall(
            """
            SELECT a.title, a.description
            FROM cluster_articles ca
            JOIN articles a ON a.id = ca.article_id
            WHERE ca.cluster_id=?
            ORDER BY ca.inserted_at DESC
            LIMIT ?
            """,
            (cluster_id, limit),
        )

        out: list[str] = []
        for r in rows:
            t = (r.get("title") or "").strip()
            d = (r.get("description") or "").strip()
            out.append(f"{t} {d}".strip())
        return out

    def get_cluster_article_titles(self, cluster_id: int, limit: int = 12) -> list[str]:
        rows = self._fetchall(
            """
            SELECT a.title
            FROM cluster_articles ca
            JOIN articles a ON a.id = ca.article_id
            WHERE ca.cluster_id=?
            ORDER BY ca.inserted_at DESC
            LIMIT ?
            """,
            (cluster_id, limit),
        )
        out: list[str] = []
        for r in rows:
            t = (r.get("title") or "").strip()
            if t:
                out.append(t)
        return out

    def get_cluster_sources(self, cluster_id: int) -> list[dict[str, Any]]:
        rows = self.connect().execute(
            """
            SELECT
                a.id,
                a.title,
                a.url,
                a.source_name,
                a.source_key,
                a.published_at,
                a.description,
                a.image_url,
                a.inserted_at
            FROM cluster_articles ca
            JOIN articles a ON a.id = ca.article_id
            WHERE ca.cluster_id = ?
            ORDER BY a.published_at DESC, a.id DESC
            """,
            (int(cluster_id),),
        ).fetchall()

        return [dict(r) for r in rows]

    def get_cluster_sources_brief(self, cluster_id: int) -> dict[str, Any]:
        """Return non-sensitive source metadata for a cluster.

        This is used for guest-locked cards. We do NOT return the full source
        list (titles/urls), but we still want to display a stable primary
        source name, a sources count, and a representative image (if any).
        """
        row = self._fetchone(
            """
            SELECT
                COUNT(*) as sources_count,
                (
                    SELECT a.source_name
                    FROM cluster_articles ca2
                    JOIN articles a ON a.id = ca2.article_id
                    WHERE ca2.cluster_id = ?
                    ORDER BY COALESCE(a.published_at, a.inserted_at) ASC, a.id ASC
                    LIMIT 1
                ) as primary_source,
                (
                    SELECT a.image_url
                    FROM cluster_articles ca3
                    JOIN articles a ON a.id = ca3.article_id
                    WHERE ca3.cluster_id = ?
                      AND a.image_url IS NOT NULL
                      AND TRIM(a.image_url) <> ''
                    ORDER BY COALESCE(a.published_at, a.inserted_at) DESC, a.id DESC
                    LIMIT 1
                ) as image_url
            FROM cluster_articles ca
            WHERE ca.cluster_id = ?
            """,
            (int(cluster_id), int(cluster_id), int(cluster_id)),
        )
        return row or {"sources_count": 0, "primary_source": None, "image_url": None}

    def get_cluster_meta(self, cluster_id: int) -> dict[str, Any]:
        return self._fetchone("SELECT * FROM clusters WHERE id=?", (cluster_id,)) or {}

    def get_cluster_latest_published_at(self, cluster_id: int) -> str | None:
        row = self._fetchone(
            """
            SELECT MAX(COALESCE(a.published_at, a.inserted_at)) as latest
            FROM cluster_articles ca
            JOIN articles a ON a.id=ca.article_id
            WHERE ca.cluster_id=?
            """,
            (int(cluster_id),),
        )
        return (row or {}).get("latest")

    def list_recent_articles_missing_image(self, *, hours: int = 48, limit: int = 50) -> list[dict[str, Any]]:
        """Return recent articles where image_url is empty."""
        try:
            hours_i = max(1, int(hours))
            lim = max(1, min(int(limit), 500))
        except Exception:
            hours_i = 48
            lim = 50

        since_iso = (datetime.now(timezone.utc) - timedelta(hours=hours_i)).replace(microsecond=0).isoformat()
        rows = self._fetchall(
            """
            SELECT id, url, source_name, inserted_at
            FROM articles
            WHERE (image_url IS NULL OR TRIM(image_url) = '')
              AND inserted_at >= ?
            ORDER BY inserted_at DESC, id DESC
            LIMIT ?
            """,
            (since_iso, lim),
        )
        return [dict(r) for r in rows]

    def list_articles_missing_image(self, *, days: int = 365, limit: int = 200) -> list[dict[str, Any]]:
        """Return articles (optionally within last N days) where image_url is empty.

        This is used for backfilling older content after improving image extraction.
        Keep it bounded with (days, limit) because it can trigger external requests.
        """
        try:
            days_i = max(1, int(days))
            lim = max(1, min(int(limit), 2000))
        except Exception:
            days_i = 365
            lim = 200

        since_iso = _utc_days_ago_iso(days_i)
        rows = self._fetchall(
            """
            SELECT id, url, source_name, inserted_at
            FROM articles
            WHERE (image_url IS NULL OR TRIM(image_url) = '')
              AND inserted_at >= ?
            ORDER BY inserted_at DESC, id DESC
            LIMIT ?
            """,
            (since_iso, lim),
        )
        return [dict(r) for r in rows]

    # --------- score/summary ----------
    def upsert_score(self, cluster_id: int, credibility_score: int, details: dict[str, Any]) -> None:
        now = _utc_now_iso()
        details_json = json.dumps(details, ensure_ascii=False)
        existing = self._fetchone("SELECT cluster_id FROM article_scores WHERE cluster_id=?", (cluster_id,))

        if existing:
            self._exec(
                "UPDATE article_scores SET credibility_score=?, score_details_json=?, computed_at=? WHERE cluster_id=?",
                (credibility_score, details_json, now, cluster_id),
            )
        else:
            self._exec(
                "INSERT INTO article_scores(cluster_id, credibility_score, score_details_json, computed_at) VALUES(?, ?, ?, ?)",
                (cluster_id, credibility_score, details_json, now),
            )

    def get_score(self, cluster_id: int) -> Optional[dict[str, Any]]:
        return self._fetchone("SELECT * FROM article_scores WHERE cluster_id=?", (cluster_id,))
    def get_video_report_cache(self, cache_key: str):
        """Return cached payload_json if present and not expired."""
        return self._fetchone(
            """
            SELECT payload_json
            FROM video_report_cache
            WHERE cache_key = ?
              AND expires_at > CURRENT_TIMESTAMP
            """,
            (cache_key,),
        )


    def get_video_report_cache_stale(self, cache_key: str):
        """Return cached payload_json even if expired (stale fallback).

        Used when the upstream provider is down / quota-limited: we prefer showing
        previously-cached results rather than an empty widget.
        """
        return self._fetchone(
            """
            SELECT payload_json, expires_at, created_at
            FROM video_report_cache
            WHERE cache_key = ?
            """,
            (cache_key,),
        )

    def set_video_report_cache(self, cache_key: str, q: str, lang: str, payload_json: str, ttl_seconds: int = 6 * 3600):
        """Upsert cache entry with TTL (default 6 hours)."""
        return self._exec(
            """
            INSERT INTO video_report_cache (cache_key, q, lang, payload_json, created_at, expires_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'))
            ON CONFLICT(cache_key) DO UPDATE SET
                q=excluded.q,
                lang=excluded.lang,
                payload_json=excluded.payload_json,
                created_at=CURRENT_TIMESTAMP,
                expires_at=datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds')
            """,
            (cache_key, q, lang, payload_json, int(ttl_seconds), int(ttl_seconds)),
        )


    # --------- trust score history ----------
    def get_trust_history(self, cluster_id: int, limit: int = 60) -> list[dict[str, Any]]:
        """Return trust score history points for a cluster (ascending time)."""
        limit = max(1, min(int(limit or 60), 500))
        rows = self._fetchall(
            """
            SELECT created_at, score, sources_count, sources_delta
            FROM trust_score_history
            WHERE cluster_id = ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (int(cluster_id), limit),
        )
        return [dict(r) for r in rows]

    # -----------------
    # Media Bias widget: source_bias + media_bias_cache
    # -----------------

    def get_source_bias(self, domain: str) -> Optional[dict[str, Any]]:
        row = self.connect().fetchone(
            """
            SELECT domain, bias, confidence, source, created_at, updated_at
            FROM source_bias
            WHERE domain = ?
            """,
            (domain,),
        )
        return dict(row) if row else None

    def upsert_source_bias(self, domain: str, bias: str, confidence: float = 0.0, source: str = "unknown") -> None:
        self._exec(
            """
            INSERT INTO source_bias (domain, bias, confidence, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(domain) DO UPDATE SET
                bias=excluded.bias,
                confidence=excluded.confidence,
                source=excluded.source,
                updated_at=CURRENT_TIMESTAMP
            """,
            (domain, bias, float(confidence), source),
        )

    def get_media_bias_cache(self, cache_key: str) -> Optional[str]:
        row = self._fetchone(
            """
            SELECT payload_json
            FROM media_bias_cache
            WHERE cache_key = ?
              AND expires_at > ?
            """,
            (cache_key, _utc_now_iso()),
        )
        return str(row.get("payload_json")) if row and row.get("payload_json") is not None else None

    def set_media_bias_cache(
        self,
        cache_key: str,
        cluster_id: int,
        payload_json: str,
        ttl_seconds: int = 3 * 3600,
        cluster_updated_at: str | None = None,
    ) -> None:
        now_iso = _utc_now_iso()
        expires_iso = (datetime.now(timezone.utc) + timedelta(seconds=max(1, int(ttl_seconds)))).replace(microsecond=0).isoformat()
        cluster_updated_at_iso = str(cluster_updated_at or now_iso)
        self._exec(
            """
            INSERT INTO media_bias_cache (cache_key, cluster_id, cluster_updated_at, payload_json, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                cluster_id=excluded.cluster_id,
                cluster_updated_at=excluded.cluster_updated_at,
                payload_json=excluded.payload_json,
                created_at=excluded.created_at,
                expires_at=excluded.expires_at
            """,
            (cache_key, int(cluster_id), cluster_updated_at_iso, payload_json, now_iso, expires_iso),
        )


    def get_latest_trust_history_point(self, cluster_id: int) -> Optional[dict[str, Any]]:
        return self._fetchone(
            """
            SELECT created_at, score, sources_count, sources_delta
            FROM trust_score_history
            WHERE cluster_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (int(cluster_id),),
        )

    def record_trust_history_if_changed(self, cluster_id: int, score: int, sources_count: int) -> bool:
        """Insert a new history point only if score or sources_count changed.

        Returns True if a new point was inserted.
        """
        now = _utc_now_iso()
        try:
            score_i = int(score)
        except Exception:
            score_i = 0
        try:
            sc_i = int(sources_count)
        except Exception:
            sc_i = 0

        prev = self.get_latest_trust_history_point(int(cluster_id)) or None
        if prev:
            try:
                prev_score = int(prev.get("score") or 0)
            except Exception:
                prev_score = 0
            try:
                prev_sc = int(prev.get("sources_count") or 0)
            except Exception:
                prev_sc = 0
            if prev_score == score_i and prev_sc == sc_i:
                return False
            delta = sc_i - prev_sc
        else:
            delta = 0

        self._exec(
            """
            INSERT INTO trust_score_history(cluster_id, score, sources_count, sources_delta, created_at)
            VALUES(?, ?, ?, ?, ?)
            """,
            (int(cluster_id), score_i, sc_i, int(delta), now),
        )
        return True

    def upsert_summary(
        self,
        cluster_id: int,
        summary_text: Optional[str],
        summary_json: Optional[str],
        model: str,
        status: str,
        raw_text: Optional[str] = None,
        source_fingerprint: Optional[str] = None,
        source_count: int = 0,
    ) -> None:
        now = _utc_now_iso()
        existing = self._fetchone("SELECT cluster_id FROM article_summaries WHERE cluster_id=?", (cluster_id,))

        if existing:
            self._exec(
                "UPDATE article_summaries SET summary_text=?, summary_json=?, raw_text=?, model=?, status=?, created_at=?, source_fingerprint=?, source_count=? WHERE cluster_id=?",
                (summary_text, summary_json, raw_text, model, status, now, source_fingerprint, int(source_count or 0), cluster_id),
            )
        else:
            self._exec(
                "INSERT INTO article_summaries(cluster_id, summary_text, summary_json, raw_text, model, status, created_at, source_fingerprint, source_count) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cluster_id, summary_text, summary_json, raw_text, model, status, now, source_fingerprint, int(source_count or 0)),
            )

    def get_summary(self, cluster_id: int) -> Optional[dict[str, Any]]:
        return self._fetchone("SELECT * FROM article_summaries WHERE cluster_id=?", (cluster_id,))

    def get_llm_pair_cache(self, cache_key: str, cache_kind: str) -> Optional[dict[str, Any]]:
        row = self._fetchone(
            "SELECT * FROM llm_pair_cache WHERE cache_key=? AND cache_kind=?",
            (str(cache_key), str(cache_kind)),
        )
        if not row:
            return None
        exp = _parse_iso_dt_simple(row.get("expires_at"))
        now = datetime.now(timezone.utc)
        if exp and exp < now:
            try:
                self._exec("DELETE FROM llm_pair_cache WHERE cache_key=? AND cache_kind=?", (str(cache_key), str(cache_kind)))
            except Exception:
                pass
            return None
        payload_raw = row.get("payload_json")
        if isinstance(payload_raw, str):
            try:
                row["payload"] = json.loads(payload_raw)
            except Exception:
                row["payload"] = None
        else:
            row["payload"] = None
        return row

    def set_llm_pair_cache(self, cache_key: str, cache_kind: str, model: str, payload: dict[str, Any], ttl_seconds: int = 6 * 60 * 60) -> None:
        now = _utc_now_iso()
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=max(60, int(ttl_seconds or 0)))).replace(microsecond=0).isoformat()
        self._exec(
            """
            INSERT INTO llm_pair_cache(cache_key, cache_kind, model, payload_json, created_at, expires_at)
            VALUES(?, ?, ?, ?, ?, ?)
            ON CONFLICT (cache_key) DO UPDATE SET
                cache_kind=excluded.cache_kind,
                model=excluded.model,
                payload_json=excluded.payload_json,
                created_at=excluded.created_at,
                expires_at=excluded.expires_at
            """,
            (str(cache_key), str(cache_kind), str(model or ""), json.dumps(payload, ensure_ascii=False), now, expires_at),
        )

    def log_ai_usage(
        self,
        *,
        feature: str,
        model: str,
        status: str,
        cache_hit: bool = False,
        latency_ms: int | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        total_tokens: int | None = None,
        meta: Optional[dict[str, Any]] = None,
    ) -> None:
        try:
            self._exec(
                """
                INSERT INTO ai_usage_events(
                    created_at, feature, model, status, cache_hit, latency_ms,
                    prompt_tokens, completion_tokens, total_tokens, meta_json
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _utc_now_iso(),
                    str(feature or "unknown"),
                    str(model or ""),
                    str(status or "unknown"),
                    bool(cache_hit),
                    int(latency_ms) if latency_ms is not None else None,
                    int(prompt_tokens) if prompt_tokens is not None else None,
                    int(completion_tokens) if completion_tokens is not None else None,
                    int(total_tokens) if total_tokens is not None else None,
                    json.dumps(meta or {}, ensure_ascii=False),
                ),
            )
        except Exception:
            pass

    def get_recent_ai_usage_summary(self, hours: int = 24) -> dict[str, Any]:
        try:
            since = (datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours or 24)))).replace(microsecond=0).isoformat()
            rows = self._fetchall(
                """
                SELECT feature, model,
                       COUNT(*) AS calls,
                       SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) AS cache_hits,
                       SUM(COALESCE(total_tokens, 0)) AS total_tokens,
                       AVG(COALESCE(latency_ms, 0)) AS avg_latency_ms
                FROM ai_usage_events
                WHERE created_at >= ?
                GROUP BY feature, model
                ORDER BY calls DESC, total_tokens DESC
                LIMIT 20
                """,
                (since,),
            )
            total = self._fetchone(
                "SELECT COUNT(*) AS calls, SUM(COALESCE(total_tokens, 0)) AS total_tokens FROM ai_usage_events WHERE created_at >= ?",
                (since,),
            ) or {}
            return {
                "since": since,
                "calls": int(total.get("calls") or 0),
                "total_tokens": int(total.get("total_tokens") or 0),
                "top": [
                    {
                        "feature": r.get("feature"),
                        "model": r.get("model"),
                        "calls": int(r.get("calls") or 0),
                        "cache_hits": int(r.get("cache_hits") or 0),
                        "total_tokens": int(r.get("total_tokens") or 0),
                        "avg_latency_ms": float(r.get("avg_latency_ms") or 0.0),
                    }
                    for r in rows
                ],
            }
        except Exception:
            return {"since": None, "calls": 0, "total_tokens": 0, "top": []}

    # --------- favorites ----------
    def upsert_favorites(self, device_id: str, cluster_ids: list[int]) -> None:
        device_id = (device_id or "").strip()
        if not device_id:
            return

        # IMPORTANT: This endpoint is used by the client as a *sync* operation.
        # It must support deletions (e.g. when the user removes items from Tracking).
        # So we treat the incoming list as the desired full set for the device.

        # Normalize & cap to avoid abuse
        normalized: list[int] = []
        seen: set[int] = set()
        for cid in (cluster_ids or [])[:500]:
            try:
                v = int(cid)
            except Exception:
                continue
            if v not in seen:
                seen.add(v)
                normalized.append(v)

        # Filter to existing cluster IDs to avoid FK errors when client sends stale ids
        if normalized:
            try:
                placeholders = ",".join(["?"] * len(normalized))
                rows = self._fetchall(f"SELECT id FROM clusters WHERE id IN ({placeholders})", tuple(normalized))
                existing = {int(r["id"]) for r in rows}
                normalized = [cid for cid in normalized if cid in existing]
            except Exception:
                # If anything goes wrong, fall back to empty (safe)
                normalized = []

        now = _utc_now_iso()
        # Single transaction
        with self.conn:
            if not normalized:
                # If client sends an empty list — clear all favorites for this device.
                self.conn.execute("DELETE FROM favorites WHERE device_id=?", (device_id,))
            else:
                placeholders = ",".join(["?"] * len(normalized))
                # Remove rows that are no longer present on the client.
                self.conn.execute(
                    f"DELETE FROM favorites WHERE device_id=? AND cluster_id NOT IN ({placeholders})",
                    (device_id, *normalized),
                )

            # Insert missing (ignore duplicates)
            self.conn.executemany(
                "INSERT OR IGNORE INTO favorites(device_id, cluster_id, created_at) VALUES(?, ?, ?)",
                [(device_id, cid, now) for cid in normalized],
            )

    def delete_favorite(self, device_id: str, cluster_id: int) -> None:
        device_id = (device_id or "").strip()
        if not device_id:
            return
        self._exec("DELETE FROM favorites WHERE device_id=? AND cluster_id=?", (device_id, int(cluster_id)))

    def get_favorite_ids(self, device_id: str) -> list[int]:
        device_id = (device_id or "").strip()
        if not device_id:
            return []

        rows = self._fetchall(
            "SELECT cluster_id FROM favorites WHERE device_id=? ORDER BY created_at DESC",
            (device_id,),
        )
        return [int(r["cluster_id"]) for r in rows]

    def get_favorites_with_state(self, device_id: str):
        """Return favorites rows with server-side tracking state."""
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT cluster_id, created_at, last_seen_score, last_seen_sources_count, last_seen_at,
                   email_alerts_enabled, last_notified_score, last_notified_sources_count, last_notified_at, last_notified_fingerprint
                FROM favorites
                WHERE device_id = ?
                ORDER BY created_at DESC
                """,
                (device_id,),
            ).fetchall()

        return [
            {
                "cluster_id": r["cluster_id"],
                "created_at": r["created_at"],
                "last_seen_score": r["last_seen_score"],
                "last_seen_sources_count": r["last_seen_sources_count"],
                "last_seen_at": r["last_seen_at"],
            }
            for r in rows
        ]

    def update_favorites_seen_state(self, device_id: str, updates):
        """Bulk update favorites seen state. updates: list of (cluster_id, score, sources_count, seen_at_iso)."""
        if not updates:
            return

        with self.connect() as conn:
            conn.executemany(
                """
                UPDATE favorites
                SET last_seen_score = ?, last_seen_sources_count = ?, last_seen_at = ?
                WHERE device_id = ? AND cluster_id = ?
                """,
                [(u[1], u[2], u[3], device_id, u[0]) for u in updates],
            )
            conn.commit()


    def is_cluster_favorited_anywhere(self, cluster_id: int) -> bool:
        row = self._fetchone("SELECT 1 as x FROM favorites WHERE cluster_id=? LIMIT 1", (int(cluster_id),))
        return bool(row)

    # -----------------
    # Auth: users + tokens
    # -----------------
    def get_user_by_email(self, email: str) -> Optional[dict[str, Any]]:
        email = (email or "").strip().lower()
        if not email:
            return None
        return self._fetchone("SELECT * FROM users WHERE email=?", (email,))

    def get_user_by_id(self, user_id: int) -> Optional[dict[str, Any]]:
        try:
            uid = int(user_id)
        except Exception:
            return None
        return self._fetchone("SELECT * FROM users WHERE id=?", (uid,))

    def touch_user_last_seen(self, user_id: int) -> None:
        """Mark an authenticated user as 'online' (for admin stats).

        Stored as UTC ISO string.
        """
        try:
            uid = int(user_id)
        except Exception:
            return

    # ----------------------------
    # User preferences (account-scoped)
    # ----------------------------
    def get_user_preferences(self, user_id: int) -> Optional[dict[str, Any]]:
        try:
            uid = int(user_id)
        except Exception:
            return None
        return self._fetchone("SELECT * FROM user_preferences WHERE user_id=?", (uid,))

    def upsert_user_preferences(
        self,
        user_id: int,
        interests_json: str | None,
        country: str | None,
        language: str | None,
        ui_json: str | None = None,
    ) -> None:
        try:
            uid = int(user_id)
        except Exception:
            return
        now = _utc_now_iso()
        # sqlite/postgres compatible upsert via UPDATE then INSERT fallback
        try:
            cur = self._exec(
                "UPDATE user_preferences SET interests_json=?, country=?, language=?, ui_json=?, updated_at=? WHERE user_id=?",
                (interests_json, country, language, ui_json, now, uid),
            )
            if getattr(cur, "rowcount", 0) and int(cur.rowcount) > 0:
                return
        except Exception:
            pass
        try:
            self._exec(
                "INSERT INTO user_preferences(user_id, interests_json, country, language, ui_json, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
                (uid, interests_json, country, language, ui_json, now),
            )
        except Exception:
            # As a last resort: try an update again
            try:
                self._exec(
                    "UPDATE user_preferences SET interests_json=?, country=?, language=?, ui_json=?, updated_at=? WHERE user_id=?",
                    (interests_json, country, language, ui_json, now, uid),
                )
            except Exception:
                return
        try:
            self._exec("UPDATE users SET last_seen_at=? WHERE id=?", (_utc_now_iso(), uid))
        except Exception:
            return

    def create_user_local(self, email: str, hashed_password: str) -> int:
        now = _utc_now_iso()
        cur = self._exec(
            "INSERT INTO users(email, hashed_password, email_verified, provider, created_at) VALUES(?, ?, 0, 'local', ?) RETURNING id",
            ((email or "").strip().lower(), hashed_password, now),
        )
        row = cur.fetchone()
        return int(row["id"]) if row else 0


    def delete_user(self, user_id: int) -> None:
        self._exec("DELETE FROM users WHERE id=?", (int(user_id),))

    def upsert_oauth_user(self, provider: str, provider_id: str, email: str, full_name: str | None = None, picture_url: str | None = None) -> int:
        provider = (provider or "").strip().lower()
        provider_id = (provider_id or "").strip()
        email = (email or "").strip().lower()
        full_name = (full_name or "").strip() or None
        picture_url = (picture_url or "").strip() or None
        now = _utc_now_iso()

        def _update_profile(uid: int) -> None:
            if full_name:
                self._exec("UPDATE users SET full_name=? WHERE id=?", (full_name, uid))
            if picture_url:
                self._exec("UPDATE users SET picture_url=? WHERE id=?", (picture_url, uid))

        row = self._fetchone("SELECT id FROM users WHERE provider=? AND provider_id=?", (provider, provider_id))
        if row:
            uid = int(row["id"])
            self._exec("UPDATE users SET email=? WHERE id=?", (email, uid))
            _update_profile(uid)
            return uid

        row = self._fetchone("SELECT id FROM users WHERE email=?", (email,))
        if row:
            uid = int(row["id"])
            self._exec("UPDATE users SET provider=?, provider_id=? WHERE id=?", (provider, provider_id, uid))
            _update_profile(uid)
            return uid

        cur = self._exec(
            "INSERT INTO users(email, hashed_password, email_verified, provider, provider_id, created_at, full_name, picture_url) VALUES(?, NULL, 1, ?, ?, ?, ?, ?) RETURNING id",
            (email, provider, provider_id, now, full_name, picture_url),
        )
        row = cur.fetchone()
        return int(row["id"]) if row else 0

    def set_user_email_verified(self, user_id: int, verified: bool) -> None:
        self._exec("UPDATE users SET email_verified=? WHERE id=?", (1 if verified else 0, int(user_id)))

    def set_user_password(self, user_id: int, hashed_password: str) -> None:
        self._exec("UPDATE users SET hashed_password=? WHERE id=?", (hashed_password, int(user_id)))

    def update_user_last_login(self, user_id: int) -> None:
        self._exec("UPDATE users SET last_login=? WHERE id=?", (_utc_now_iso(), int(user_id)))

    def create_auth_token(self, user_id: int, token_type: str, token_hash: str, expires_minutes: int) -> None:
        now = datetime.now(timezone.utc)
        exp = now + timedelta(minutes=expires_minutes)
        self._exec(
            "INSERT INTO auth_tokens(user_id, token_type, token_hash, expires_at, created_at) VALUES(?, ?, ?, ?, ?)",
            (int(user_id), token_type, token_hash, exp.replace(microsecond=0).isoformat(), now.replace(microsecond=0).isoformat()),
        )

    def consume_auth_token(self, token_type: str, raw_token: str) -> Optional[dict[str, Any]]:
        from .auth.security import token_hash as _th

        th = _th((raw_token or "").strip())
        now_iso = _utc_now_iso()
        row = self._fetchone(
            "SELECT * FROM auth_tokens WHERE token_type=? AND token_hash=? AND consumed_at IS NULL AND expires_at > ?",
            (token_type, th, now_iso),
        )
        if not row:
            return None
        self._exec("UPDATE auth_tokens SET consumed_at=? WHERE id=?", (now_iso, int(row["id"])))
        return row

    # -----------------
    # Auth: per-user favorites (Tracking)
    # -----------------
    def upsert_user_favorites(self, user_id: int, cluster_ids: list[int]) -> None:
        uid = int(user_id)
        normalized: list[int] = []
        seen: set[int] = set()
        for cid in (cluster_ids or [])[:500]:
            try:
                v = int(cid)
            except Exception:
                continue
            if v not in seen:
                seen.add(v)
                normalized.append(v)

        # Filter to existing cluster IDs to avoid FK errors when client sends stale ids
        if normalized:
            try:
                placeholders = ",".join(["?"] * len(normalized))
                rows = self._fetchall(f"SELECT id FROM clusters WHERE id IN ({placeholders})", tuple(normalized))
                existing = {int(r["id"]) for r in rows}
                normalized = [cid for cid in normalized if cid in existing]
            except Exception:
                # If anything goes wrong, fall back to empty (safe)
                normalized = []

        now = _utc_now_iso()
        with self.conn:
            if not normalized:
                self.conn.execute("DELETE FROM user_favorites WHERE user_id=?", (uid,))
            else:
                placeholders = ",".join(["?"] * len(normalized))
                self.conn.execute(
                    f"DELETE FROM user_favorites WHERE user_id=? AND cluster_id NOT IN ({placeholders})",
                    (uid, *normalized),
                )

            self.conn.executemany(
                "INSERT OR IGNORE INTO user_favorites(user_id, cluster_id, created_at) VALUES(?, ?, ?)",
                [(uid, cid, now) for cid in normalized],
            )

    def get_user_favorite_ids(self, user_id: int) -> list[int]:
        rows = self._fetchall(
            "SELECT cluster_id FROM user_favorites WHERE user_id=? ORDER BY created_at DESC",
            (int(user_id),),
        )
        return [int(r["cluster_id"]) for r in rows]

    def is_cluster_user_favorited(self, user_id: int, cluster_id: int) -> bool:
        row = self._fetchone(
            "SELECT 1 as x FROM user_favorites WHERE user_id=? AND cluster_id=? LIMIT 1",
            (int(user_id), int(cluster_id)),
        )
        return bool(row)
    def delete_user_favorite(self, user_id: int, cluster_id: int) -> None:
        self._exec("DELETE FROM user_favorites WHERE user_id=? AND cluster_id=?", (int(user_id), int(cluster_id)))

    def get_user_favorites_with_state(self, user_id: int) -> list[dict[str, Any]]:
        rows = self._fetchall(
            """
            SELECT cluster_id, created_at, last_seen_score, last_seen_sources_count, last_seen_at,
                   email_alerts_enabled, last_notified_score, last_notified_sources_count, last_notified_at, last_notified_fingerprint
            FROM user_favorites
            WHERE user_id=?
            ORDER BY created_at DESC
            """,
            (int(user_id),),
        )
        return rows

    def update_user_favorites_seen_state(self, user_id: int, updates) -> None:
        if not updates:
            return
        uid = int(user_id)
        with self.connect() as conn:
            conn.executemany(
                """
                UPDATE user_favorites
                SET last_seen_score = ?, last_seen_sources_count = ?, last_seen_at = ?
                WHERE user_id = ? AND cluster_id = ?
                """,
                [(u[1], u[2], u[3], uid, u[0]) for u in updates],
            )
            conn.commit()


    def set_user_favorite_email_alert(
        self,
        user_id: int,
        cluster_id: int,
        enabled: bool,
        *,
        current_score: Optional[int] = None,
        current_sources_count: Optional[int] = None,
    ) -> None:
        """Enable/disable per-event email alerts.

        When enabling, we snapshot the current state as 'last_notified_*' so the user
        doesn't get an immediate email for the current score; only for *future changes*.
        """
        uid = int(user_id)
        cid = int(cluster_id)
        en = 1 if enabled else 0
        now = _utc_now_iso()
        with self._lock:
            if enabled:
                self.connect().execute(
                    """
                    UPDATE user_favorites
                    SET email_alerts_enabled = 1,
                        last_notified_score = COALESCE(?, last_notified_score),
                        last_notified_sources_count = COALESCE(?, last_notified_sources_count),
                        last_notified_at = COALESCE(?, last_notified_at)
                    WHERE user_id = ? AND cluster_id = ?
                    """,
                    (current_score, current_sources_count, now, uid, cid),
                )
            else:
                self.connect().execute(
                    """
                    UPDATE user_favorites
                    SET email_alerts_enabled = 0
                    WHERE user_id = ? AND cluster_id = ?
                    """,
                    (uid, cid),
                )
            self.connect().commit()

    def get_email_alert_targets(self, limit: int = 200) -> list[dict[str, Any]]:
        """Return tracked events that have email alerts enabled, with user email."""
        rows = self._fetchall(
            """
            SELECT
                uf.user_id,
                uf.cluster_id,
                uf.email_alerts_enabled,
                uf.last_notified_score,
                uf.last_notified_sources_count,
                uf.last_notified_at,
                uf.last_notified_fingerprint,
                u.email as user_email,
                u.email_verified as user_email_verified
            FROM user_favorites uf
            JOIN users u ON u.id = uf.user_id
            WHERE uf.email_alerts_enabled = 1
            ORDER BY COALESCE(uf.last_notified_at, uf.created_at) ASC
            LIMIT ?
            """,
            (int(limit),),
        )
        return rows

    def update_email_alert_notified_state(
        self,
        user_id: int,
        cluster_id: int,
        *,
        new_score: int,
        new_sources_count: int,
        fingerprint: str,
        notified_at_iso: Optional[str] = None,
    ) -> None:
        uid = int(user_id)
        cid = int(cluster_id)
        ts = (notified_at_iso or _utc_now_iso())
        with self._lock:
            self.connect().execute(
                """
                UPDATE user_favorites
                SET last_notified_score = ?,
                    last_notified_sources_count = ?,
                    last_notified_at = ?,
                    last_notified_fingerprint = ?
                WHERE user_id = ? AND cluster_id = ?
                """,
                (int(new_score), int(new_sources_count), ts, str(fingerprint), uid, cid),
            )
            self.connect().commit()


    # -----------------
    # Email alerts (global toggle)
    # -----------------
    def get_user_email_alerts_enabled(self, user_id: int) -> bool:
        row = self._fetchone(
            "SELECT 1 as x FROM user_favorites WHERE user_id=? AND email_alerts_enabled=1 LIMIT 1",
            (int(user_id),),
        )
        return bool(row)

    def set_user_email_alerts_enabled_all(self, user_id: int, enabled: bool) -> None:
        """Enable/disable email alerts for *all* tracked events for a user.

        When enabling, we baseline the last_notified_* fields to the current state
        so the user doesn't get an immediate email for old changes.
        """
        uid = int(user_id)
        en = 1 if enabled else 0
        now = _utc_now_iso()

        self._exec("UPDATE user_favorites SET email_alerts_enabled=? WHERE user_id=?", (en, uid))

        if not enabled:
            return

        rows = self._fetchall("SELECT cluster_id FROM user_favorites WHERE user_id=?", (uid,))
        cluster_ids = [int(r["cluster_id"]) for r in rows]
        if not cluster_ids:
            return

        updates = []
        for cid in cluster_ids:
            score_row = self.get_score(cid) or {}
            score = int(score_row.get("credibility_score") or 0)
            sources_count = len(self.get_cluster_sources(cid) or [])
            fingerprint = f"{score}|{sources_count}"
            # Do NOT set last_notified_at here, so the next real change is not
            # blocked by the notify loop's minimum interval.
            updates.append((score, sources_count, None, fingerprint, uid, cid))

        with self.connect() as conn:
            conn.executemany(
                """
                UPDATE user_favorites
                SET last_notified_score=?,
                    last_notified_sources_count=?,
                    last_notified_at=?,
                    last_notified_fingerprint=?
                WHERE user_id=? AND cluster_id=?
                """,
                updates,
            )
            conn.commit()


    def set_user_email_alerts_enabled(self, user_id: int, enabled: bool):
            return self.set_user_email_alerts_enabled_all(user_id, enabled)

    # --------- API query ----------
    def query_clusters(
        self,
        interests: list[str],
        country: str,
        language: str,
        since_iso: Optional[str],
        limit: int = 120,
    ) -> list[dict[str, Any]]:
        interests_norm = _normalize_interest_selection(interests)
        country = (country or "").strip().lower()
        language = (language or "all").strip().lower()

        country_language_map: dict[str, tuple[str, ...]] = {
            "us": ("en",),
            "gb": ("en",),
            "de": ("de", "en"),
            "fr": ("fr", "en"),
        }

        base_where: list[str] = []
        base_params: list[Any] = []

        latest_published_expr = """
            (
                SELECT MAX(COALESCE(a_latest.published_at, a_latest.inserted_at))
                FROM cluster_articles ca_latest
                JOIN articles a_latest ON a_latest.id = ca_latest.article_id
                WHERE ca_latest.cluster_id = c.id
            )
        """.strip()

        def _fetch_query_rows(extra_where: list[str], extra_params: list[Any], row_limit: int, exclude_ids: list[int] | None = None) -> list[dict[str, Any]]:
            where = list(extra_where)
            params = list(extra_params)
            if exclude_ids:
                placeholders = ",".join("?" for _ in exclude_ids)
                where.append(f"c.id NOT IN ({placeholders})")
                params.extend(exclude_ids)
            if since_iso:
                where.append(f"COALESCE({latest_published_expr}, c.updated_at) >= ?")
                params.append(since_iso)
            if not where:
                where.append("1=1")
            sql = f"""
                SELECT
                    c.*,
                    {latest_published_expr} AS latest_published_at,
                    s.credibility_score,
                    s.score_details_json,
                    s.computed_at as score_computed_at,
                    sm.summary_text,
                    sm.summary_json,
                    sm.raw_text as summary_raw_text,
                    sm.status as summary_status,
                    sm.model as summary_model
                FROM clusters c
                LEFT JOIN article_scores s ON s.cluster_id=c.id
                LEFT JOIN article_summaries sm ON sm.cluster_id=c.id
                WHERE {" AND ".join(where)}
                ORDER BY COALESCE({latest_published_expr}, c.updated_at) DESC, c.updated_at DESC, c.id DESC
                LIMIT ?
            """
            requested_limit = max(1, min(500, int(row_limit)))
            # On the production DB, cluster.updated_at can lag behind the freshest
            # article merged into a cluster. Pulling a broader slice keeps the
            # world feed fresh even when older clusters receive new source updates.
            fetch_limit = min(1200, max(requested_limit * 5, 600))
            params.append(fetch_limit)
            return self._fetchall(sql, tuple(params))

        if country in country_language_map:
            # Country feeds should feel local. On older production DBs the cluster
            # metadata can lag behind reality (e.g. local outlet articles merged
            # into `world` clusters, or cluster.language left too broad), so we
            # scope by the underlying articles as well — not only cluster columns.
            allowed_langs = list(country_language_map[country])
            if language and language not in {"all", "*"}:
                if language in allowed_langs:
                    allowed_langs = [language]
                elif language == "en" and "en" in allowed_langs:
                    # Keep local + English for country feeds in the default English UI.
                    allowed_langs = list(country_language_map[country])
                else:
                    allowed_langs = [language]

            local_where: list[str] = []
            local_params: list[Any] = []
            _append_cluster_or_article_language(local_where, local_params, allowed_langs)
            _append_local_source_exists(local_where, local_params, country)
            rows = _fetch_query_rows(local_where, local_params, limit)

            # Extremely old rows may miss article.language as well. In that case,
            # trust the local source matcher and return those rows even without a
            # language match so the main site doesn't show an empty regional feed.
            if not rows:
                legacy_local_where: list[str] = []
                legacy_local_params: list[Any] = []
                _append_local_source_exists(legacy_local_where, legacy_local_params, country)
                rows = _fetch_query_rows(legacy_local_where, legacy_local_params, limit)

            # Final safety net: keep the UI non-empty if the DB truly has no local rows yet.
            if not rows:
                fallback_where: list[str] = []
                fallback_params: list[Any] = []
                _append_cluster_or_article_language(fallback_where, fallback_params, allowed_langs)
                fallback_where.append("c.country='world'")
                rows = _fetch_query_rows(fallback_where, fallback_params, limit)
        else:
            if language and language not in {"all", "*"}:
                base_where.append("c.language=?")
                base_params.append(language)

            if country and country != "world":
                base_where.append("(c.country=? OR c.country='world')")
                base_params.append(country)
            # World feed must aggregate all countries. Restricting to c.country='world'
            # hides fresh clusters classified as us/de/fr/gb on production datasets.

            rows = _fetch_query_rows(base_where, base_params, limit)

        def _infer_topic_from_title(title: str) -> str:
            """Best-effort topic inference for legacy rows.

            Production DBs can contain clusters where `topic` is missing or overly
            broad (e.g. "general"). The UI interest chips should still work
            reasonably, so we infer a topic from the title as a fallback.
            """
            t = (title or "").lower()

            # Keep this deterministic and lightweight (no ML). It's only a fallback.
            if any(k in t for k in (
                "stock", "stocks", "market", "inflation", "economy", "economic", "trade",
                "bank", "banks", "earnings", "ipo", "bond", "bonds", "crypto", "bitcoin", "ethereum"
            )):
                return "business"
            if any(k in t for k in (
                "artificial intelligence", "machine learning", " ai", "ai ", "chip", "chips",
                "semiconductor", "iphone", "android", "google", "apple", "microsoft", "openai",
                "cyber", "hack", "hacker", "ransomware", "software", "app", "technology", "tech"
            )):
                return "technology"
            if any(k in t for k in (
                "election", "parliament", "congress", "senate", "minister", "president", "prime minister",
                "labour", "conservative", "republican", "democrat", "campaign", "vote", "voting",
                "ukraine", "russia", "israel", "gaza", "iran", "china", "taiwan", "sanctions"
            )):
                return "politics"
            if any(k in t for k in (
                "study", "research", "scientist", "nasa", "space", "planet", "asteroid",
                "climate", "warming", "physics", "chemistry", "biology"
            )):
                return "science"
            if any(k in t for k in (
                "match", "league", "goal", "tournament", "championship", "nba", "nfl", "mlb", "nhl",
                "fifa", "uefa", "premier league", "tennis", "boxing", "ufc"
            )):
                return "sports"
            if any(k in t for k in (
                "health", "hospital", "doctor", "vaccine", "covid", "flu", "disease",
                "cancer", "mental health", "diet", "obesity"
            )):
                return "health"
            return "general"

        if interests_norm:
            # Broad mode = no topic restriction. This is true for explicit General
            # and also for the natural union of all core interests.
            if _is_broad_interest_selection(interests_norm):
                return rows

            filtered: list[dict[str, Any]] = []
            for r in rows:
                title_l = (r.get("title") or "").lower()
                topic_l = (r.get("topic") or "").strip().lower()
                inferred = _infer_topic_from_title(title_l) if (not topic_l or topic_l == "general") else topic_l

                # Union semantics across selected interests.
                if any(i == inferred or i in title_l for i in interests_norm):
                    filtered.append(r)
            rows = filtered

        return rows

    def get_clusters_by_ids(self, ids: list[int]) -> list[dict[str, Any]]:
        if not ids:
            return []
        placeholders = ",".join(["?"] * len(ids))
        sql = f"""
            SELECT
                c.*,
                (
                    SELECT MAX(COALESCE(a_latest.published_at, a_latest.inserted_at))
                    FROM cluster_articles ca_latest
                    JOIN articles a_latest ON a_latest.id = ca_latest.article_id
                    WHERE ca_latest.cluster_id = c.id
                ) AS latest_published_at,
                s.credibility_score,
                s.score_details_json,
                s.computed_at as score_computed_at,
                sm.summary_text,
                sm.summary_json,
                sm.raw_text as summary_raw_text,
                sm.status as summary_status,
                sm.model as summary_model
            FROM clusters c
            LEFT JOIN article_scores s ON s.cluster_id=c.id
            LEFT JOIN article_summaries sm ON sm.cluster_id=c.id
            WHERE c.id IN ({placeholders})
        """
        return self._fetchall(sql, tuple(ids))

    # --------- cleanup ----------
    def cleanup_old_data(self, keep_days: int = 30) -> dict[str, Any]:
        cutoff = _utc_days_ago_iso(keep_days)
        old_clusters = self._fetchall("SELECT id FROM clusters WHERE updated_at < ?", (cutoff,))

        deleted_clusters = 0
        for r in old_clusters:
            cid = int(r["id"])
            if self.is_cluster_favorited_anywhere(cid):
                continue
            self._exec("DELETE FROM clusters WHERE id=?", (cid,))
            deleted_clusters += 1

        self._exec(
            """
            DELETE FROM articles
            WHERE id IN (
                SELECT a.id
                FROM articles a
                LEFT JOIN cluster_articles ca ON ca.article_id=a.id
                WHERE ca.article_id IS NULL
            )
            """
        )

        return {"cutoff": cutoff, "deleted_clusters": deleted_clusters}


db = Database()
