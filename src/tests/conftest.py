import sys
import types
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Lightweight psycopg2 stub so tests can import modules without a real DB driver.
psycopg2_stub = types.ModuleType('psycopg2')
psycopg2_stub.IntegrityError = Exception
psycopg2_stub.connect = lambda *args, **kwargs: None
extras_stub = types.ModuleType('psycopg2.extras')
extras_stub.RealDictCursor = object
extras_stub.DictCursor = object
psycopg2_stub.extras = extras_stub
sys.modules.setdefault('psycopg2', psycopg2_stub)
sys.modules.setdefault('psycopg2.extras', extras_stub)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv('APP_ENV', 'test')
    monkeypatch.setenv('AUTH_SECRET_KEY', 'test-secret-key')
    monkeypatch.setenv('DISABLE_BACKGROUND_TASKS', '1')
    monkeypatch.setenv('CORS_ORIGINS', 'http://localhost:3000')

    from src.app import main as main_module
    from src.app.routers import auth as auth_router
    from src.app.routers import news as news_router

    users: dict[str, dict[str, Any]] = {}
    auth_tokens: dict[tuple[str, str], dict[str, Any]] = {}
    last_user_id = {'value': 0}

    def next_user_id() -> int:
        last_user_id['value'] += 1
        return last_user_id['value']

    monkeypatch.setattr(main_module.db, 'ensure_schema', lambda: None)
    monkeypatch.setattr(main_module.db, 'get_last_ingest_run', lambda: '2026-03-18T12:00:00+00:00')

    monkeypatch.setattr(auth_router.db, 'get_user_by_email', lambda email: users.get(email))

    def create_user_local(email: str, hashed_password: str):
        user_id = next_user_id()
        users[email] = {
            'id': user_id,
            'email': email,
            'hashed_password': hashed_password,
            'provider': 'local',
            'email_verified': 0,
            'email_alerts_enabled': 0,
        }
        return user_id

    def create_auth_token(user_id: int, token_type: str, token_hash: str, expires_minutes: int):
        auth_tokens[(token_type, token_hash)] = {'user_id': user_id}

    def consume_auth_token(token_type: str, raw_token: str):
        key = (token_type, auth_router.token_hash(raw_token))
        return auth_tokens.pop(key, None)

    def set_user_email_verified(user_id: int, value: bool):
        for user in users.values():
            if user['id'] == user_id:
                user['email_verified'] = 1 if value else 0
                return

    monkeypatch.setattr(auth_router.db, 'create_user_local', create_user_local)
    monkeypatch.setattr(auth_router.db, 'create_auth_token', create_auth_token)
    monkeypatch.setattr(auth_router.db, 'consume_auth_token', consume_auth_token)
    monkeypatch.setattr(auth_router.db, 'set_user_email_verified', set_user_email_verified)
    monkeypatch.setattr(auth_router.db, 'update_user_last_login', lambda user_id: None)
    monkeypatch.setattr(auth_router, 'send_email', lambda **kwargs: True)
    monkeypatch.setattr(auth_router, 'public_base_url', lambda: 'http://localhost:3000')

    monkeypatch.setattr(news_router.db, 'ensure_schema', lambda: None)
    monkeypatch.setattr(news_router.db, 'query_clusters', lambda **kwargs: [{'id': 101, 'cluster_id': 101, 'title': 'Alpha story'}])
    monkeypatch.setattr(news_router.db, 'get_user_subscription', lambda user_id: None)
    monkeypatch.setattr(news_router.db, 'get_clusters_by_ids', lambda ids: [{'id': 101, 'cluster_id': 101, 'title': 'Alpha story'}])
    monkeypatch.setattr(news_router, '_decorate_cluster_row', lambda row, include_sources=True: {
        'cluster_id': int(row.get('id') or row.get('cluster_id') or 101),
        'title': row.get('title') or 'Alpha story',
        'latest_published_at': '2026-03-18T11:00:00+00:00',
        'updated_at': '2026-03-18T11:05:00+00:00',
        'importance': 80,
        'credibility_score': 88,
        'sources_count': 3,
        'sources': [] if not include_sources else [{'source_name': 'BBC', 'title': 'Alpha story'}],
    })

    async def passthrough(items, ui_lang):
        return items

    monkeypatch.setattr(news_router, 'translate_feed_items', passthrough)

    with TestClient(main_module.app) as test_client:
        test_client._users = users
        yield test_client
