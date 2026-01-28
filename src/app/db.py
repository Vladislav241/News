from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .models import AppConfig
from .sources import normalize_source_key


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _utc_days_ago_iso(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.replace(microsecond=0).isoformat()


class Database:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None

    @property
    def conn(self) -> sqlite3.Connection:
        """Public alias for the underlying SQLite connection.

        Some parts of the codebase expect `Database.conn` to exist.
        We keep the real connection in `_conn` and expose it here.
        """
        if self._conn is None:
            raise RuntimeError("Database is not connected. Call db.connect(db_path) first.")
        return self._conn

    def get_config(self) -> AppConfig:
        return AppConfig(
            db_path=os.getenv("DB_PATH", "news.db"),
            refresh_interval_seconds=int(os.getenv("REFRESH_INTERVAL_SECONDS", "900")),
            rss_sources_json=os.getenv("RSS_SOURCES_JSON", "").strip(),
            newsapi_key=os.getenv("NEWSAPI_KEY", "").strip(),
            openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
            max_external_requests_per_cycle=int(os.getenv("MAX_EXTERNAL_REQUESTS_PER_CYCLE", "60")),
            refresh_token=os.getenv("REFRESH_TOKEN", "").strip(),
        )

    def connect(self) -> sqlite3.Connection:
        cfg = self.get_config()
        with self._lock:
            if self._conn is None:
                conn = sqlite3.connect(cfg.db_path, check_same_thread=False)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute("PRAGMA synchronous=NORMAL;")
                conn.execute("PRAGMA foreign_keys=ON;")
                self._conn = conn
            return self._conn

    def _has_column(self, table: str, col: str) -> bool:
        conn = self.connect()
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        cols = {r[1] for r in rows}  # name
        return col in cols

    def ensure_schema(self) -> None:
        conn = self.connect()
        with self._lock:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    url TEXT NOT NULL,
                    url_hash TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    published_at TEXT,
                    content TEXT,
                    description TEXT,
                    raw_json TEXT,
                    topic TEXT,
                    country TEXT,
                    language TEXT,
                    inserted_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url_hash ON articles(url_hash);

                CREATE TABLE IF NOT EXISTS clusters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cluster_key TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    topic TEXT,
                    country TEXT,
                    language TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters(updated_at);
                CREATE INDEX IF NOT EXISTS idx_clusters_lang ON clusters(language);
                CREATE INDEX IF NOT EXISTS idx_clusters_country ON clusters(country);
                CREATE INDEX IF NOT EXISTS idx_clusters_topic ON clusters(topic);

                CREATE TABLE IF NOT EXISTS cluster_articles (
                    cluster_id INTEGER NOT NULL,
                    article_id INTEGER NOT NULL,
                    inserted_at TEXT NOT NULL,
                    PRIMARY KEY (cluster_id, article_id),
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
                    FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_cluster_articles_article ON cluster_articles(article_id);

                CREATE TABLE IF NOT EXISTS article_scores (
                    cluster_id INTEGER PRIMARY KEY,
                    credibility_score INTEGER NOT NULL,
                    score_details_json TEXT NOT NULL,
                    computed_at TEXT NOT NULL,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS article_summaries (
                    cluster_id INTEGER PRIMARY KEY,
                    summary_text TEXT,
                    model TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ingest_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    status TEXT NOT NULL,
                    stats_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS favorites (
                    device_id TEXT NOT NULL,
                    cluster_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,

                    -- Server-side tracking state (so tracking deltas work across devices)
                    last_seen_score INTEGER,
                    last_seen_sources_count INTEGER,
                    last_seen_at TEXT,

                    PRIMARY KEY (device_id, cluster_id)
                );

                CREATE INDEX IF NOT EXISTS idx_favorites_cluster ON favorites(cluster_id);
                CREATE INDEX IF NOT EXISTS idx_favorites_device ON favorites(device_id);

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

                -- -----------------
                -- Auth (users + tokens + per-user favorites)
                -- -----------------
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE,
                    hashed_password TEXT,
                    email_verified INTEGER NOT NULL DEFAULT 0,
                    provider TEXT NOT NULL DEFAULT 'local',
                    provider_id TEXT,
                    created_at TEXT NOT NULL,
                    last_login TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);

                CREATE TABLE IF NOT EXISTS auth_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token_type TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    consumed_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_auth_tokens_type ON auth_tokens(token_type);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);

                CREATE TABLE IF NOT EXISTS user_favorites (
                    user_id INTEGER NOT NULL,
                    cluster_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_score INTEGER,
                    last_seen_sources_count INTEGER,
                    last_seen_at TEXT,
                    PRIMARY KEY (user_id, cluster_id),
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_user_favs_user ON user_favorites(user_id);
                CREATE INDEX IF NOT EXISTS idx_user_favs_cluster ON user_favorites(cluster_id);
                """
            )

            # ---- MIGRATIONS ----
            if not self._has_column("articles", "source_key"):
                conn.execute("ALTER TABLE articles ADD COLUMN source_key TEXT;")

            if not self._has_column("articles", "image_url"):
                conn.execute("ALTER TABLE articles ADD COLUMN image_url TEXT;")

            if not self._has_column("article_summaries", "summary_json"):
                conn.execute("ALTER TABLE article_summaries ADD COLUMN summary_json TEXT;")

            if not self._has_column("article_summaries", "raw_text"):
                conn.execute("ALTER TABLE article_summaries ADD COLUMN raw_text TEXT;")


            # Favorites tracking state (server-side deltas for Tracking UI)
            if not self._has_column("favorites", "last_seen_score"):
                conn.execute("ALTER TABLE favorites ADD COLUMN last_seen_score INTEGER;")

            if not self._has_column("favorites", "last_seen_sources_count"):
                conn.execute("ALTER TABLE favorites ADD COLUMN last_seen_sources_count INTEGER;")

            if not self._has_column("favorites", "last_seen_at"):
                conn.execute("ALTER TABLE favorites ADD COLUMN last_seen_at TEXT;")

            conn.commit()

    # --------- helpers ----------
    def _exec(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        conn = self.connect()
        with self._lock:
            cur = conn.execute(sql, params)
            conn.commit()
            return cur

    def _fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> Optional[dict[str, Any]]:
        conn = self.connect()
        with self._lock:
            row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def _fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        conn = self.connect()
        with self._lock:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    # --------- ingest runs ----------
    def start_ingest_run(self) -> int:
        cur = self._exec(
            "INSERT INTO ingest_runs(started_at, status, stats_json) VALUES(?, ?, ?)",
            (_utc_now_iso(), "running", json.dumps({})),
        )
        return int(cur.lastrowid)

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

        cur = self._exec(
            """
            INSERT OR IGNORE INTO articles(
                title, url, url_hash, source_name, source_key, published_at,
                content, description, raw_json,
                topic, country, language, image_url, inserted_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (article.get("title") or "").strip() or "(no title)",
                url,
                url_hash,
                src_name,
                src_key,
                (article.get("published_at") or None),
                (article.get("content") or None),
                (article.get("description") or None),
                json.dumps(article.get("raw") or {}, ensure_ascii=False),
                (article.get("topic") or "general").strip().lower(),
                (article.get("country") or "world").strip().lower(),
                (article.get("language") or "en").strip().lower(),
                (article.get("image_url") or None),
                _utc_now_iso(),
            ),
        )

        # Если запись уже была (url_hash существует) — INSERT OR IGNORE ничего не вставит
        if not cur.lastrowid:
            return None

        return int(cur.lastrowid)


    def get_article_by_id(self, article_id: int) -> dict[str, Any]:
        row = self._fetchone("SELECT * FROM articles WHERE id=?", (article_id,))
        return row or {}

    def update_article_image_url(self, article_id: int, image_url: str) -> None:
        self._exec("UPDATE articles SET image_url=? WHERE id=?", (image_url, int(article_id)))

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
            VALUES(?, ?, ?, ?, ?, ?, ?)
            """,
            (cluster_key, title, topic, country, language, now, now),
        )
        return int(cur.lastrowid)

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
        except sqlite3.IntegrityError:
            return False

    def list_recent_clusters(self, language: str, limit: int = 600) -> list[dict[str, Any]]:
        return self._fetchall(
            """
            SELECT id, cluster_key, title, topic, country, language, created_at, updated_at
            FROM clusters
            WHERE language=?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (language, limit),
        )

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

    def upsert_summary(
        self,
        cluster_id: int,
        summary_text: Optional[str],
        summary_json: Optional[str],
        model: str,
        status: str,
        raw_text: Optional[str] = None,
    ) -> None:
        now = _utc_now_iso()
        existing = self._fetchone("SELECT cluster_id FROM article_summaries WHERE cluster_id=?", (cluster_id,))

        if existing:
            self._exec(
                "UPDATE article_summaries SET summary_text=?, summary_json=?, raw_text=?, model=?, status=?, created_at=? WHERE cluster_id=?",
                (summary_text, summary_json, raw_text, model, status, now, cluster_id),
            )
        else:
            self._exec(
                "INSERT INTO article_summaries(cluster_id, summary_text, summary_json, raw_text, model, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (cluster_id, summary_text, summary_json, raw_text, model, status, now),
            )

    def get_summary(self, cluster_id: int) -> Optional[dict[str, Any]]:
        return self._fetchone("SELECT * FROM article_summaries WHERE cluster_id=?", (cluster_id,))

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
                SELECT cluster_id, created_at, last_seen_score, last_seen_sources_count, last_seen_at
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

    def create_user_local(self, email: str, hashed_password: str) -> int:
        now = _utc_now_iso()
        cur = self._exec(
            "INSERT INTO users(email, hashed_password, email_verified, provider, created_at) VALUES(?, ?, 0, 'local', ?)",
            ((email or "").strip().lower(), hashed_password, now),
        )
        return int(cur.lastrowid)

    def upsert_oauth_user(self, provider: str, provider_id: str, email: str) -> int:
        provider = (provider or "").strip().lower()
        provider_id = (provider_id or "").strip()
        email = (email or "").strip().lower()
        now = _utc_now_iso()

        # existing by provider id
        row = self._fetchone("SELECT id FROM users WHERE provider=? AND provider_id=?", (provider, provider_id))
        if row:
            # update email if changed
            self._exec("UPDATE users SET email=? WHERE id=?", (email, int(row["id"])))
            return int(row["id"])

        # existing by email
        row = self._fetchone("SELECT id FROM users WHERE email=?", (email,))
        if row:
            self._exec("UPDATE users SET provider=?, provider_id=? WHERE id=?", (provider, provider_id, int(row["id"])))
            return int(row["id"])

        cur = self._exec(
            "INSERT INTO users(email, hashed_password, email_verified, provider, provider_id, created_at) VALUES(?, NULL, 1, ?, ?, ?)",
            (email, provider, provider_id, now),
        )
        return int(cur.lastrowid)

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

    def delete_user_favorite(self, user_id: int, cluster_id: int) -> None:
        self._exec("DELETE FROM user_favorites WHERE user_id=? AND cluster_id=?", (int(user_id), int(cluster_id)))

    def get_user_favorites_with_state(self, user_id: int) -> list[dict[str, Any]]:
        rows = self._fetchall(
            """
            SELECT cluster_id, created_at, last_seen_score, last_seen_sources_count, last_seen_at
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

    # --------- API query ----------
    def query_clusters(
        self,
        interests: list[str],
        country: str,
        language: str,
        since_iso: Optional[str],
        limit: int = 120,
    ) -> list[dict[str, Any]]:
        interests_norm = [i.strip().lower() for i in interests if i.strip()]
        country = (country or "").strip().lower()
        language = (language or "en").strip().lower()

        where = ["c.language=?"]
        params: list[Any] = [language]

        if country:
            where.append("(c.country=? OR c.country='world')")
            params.append(country)

        if since_iso:
            where.append("c.updated_at >= ?")
            params.append(since_iso)

        sql = f"""
            SELECT
                c.*,
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
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT ?
        """
        params.append(max(1, min(400, int(limit))))
        rows = self._fetchall(sql, tuple(params))

        if interests_norm:
            filtered: list[dict[str, Any]] = []
            for r in rows:
                t = (r.get("title") or "").lower()
                topic = (r.get("topic") or "").lower()
                if any(i == topic or i in t for i in interests_norm):
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
