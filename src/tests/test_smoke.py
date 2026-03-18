def test_health_ok(client):
    res = client.get('/health')
    assert res.status_code == 200
    body = res.json()
    assert body['status'] in {'ok', 'degraded'}
    assert 'X-Request-ID' in res.headers


def test_register_and_login_flow(client):
    register = client.post('/api/auth/register', json={'email': 'user@example.com', 'password': 'Password123'})
    assert register.status_code == 200, register.text

    user = client._users['user@example.com']
    user['email_verified'] = 1

    login = client.post('/api/auth/login', json={'email': 'user@example.com', 'password': 'Password123'})
    assert login.status_code == 200, login.text
    assert login.json()['status'] == 'ok'
    assert 'session=' in login.headers.get('set-cookie', '')


def test_feed_returns_items(client):
    res = client.get('/api/news?country=world&language=all&ui_lang=en&limit=10')
    assert res.status_code == 200, res.text
    body = res.json()
    assert body['status'] == 'ok'
    assert isinstance(body['items'], list)
    assert body['items'][0]['cluster_id'] == 101


def test_load_story_endpoint_does_not_fail(client):
    res = client.get('/api/news/by_ids?ids=101&country=world&language=all&ui_lang=en')
    assert res.status_code == 200, res.text
    body = res.json()
    assert body['status'] == 'ok'
    assert isinstance(body['items'], list)
