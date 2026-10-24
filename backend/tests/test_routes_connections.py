"""Contract tests for the connection and OAuth endpoints.

`web/src/routes/connections.tsx` branches on `oauthSupported`, `oauthConfigured`,
`apiKeySupported` and `apiKeyConnected`, so those four derived booleans are the main
thing being pinned here — along with the 302 (not 307) redirects, which a browser
would otherwise re-POST.
"""

from __future__ import annotations

import httpx
import psycopg
import pytest

from tests.conftest import requires_test_db, resolve_test_database_url


@pytest.fixture
def seeded_connections() -> None:
    """A representative row per auth style, plus the retired 'linkedin'."""
    url = resolve_test_database_url()
    assert url is not None
    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO connections (id, name, label, enabled, oauth_connected, access_token)
            VALUES (1, 'github',          'GitHub',          true,  true,  'gho_x'),
                   (2, 'clickup',         'ClickUp',         true,  true,  'pk_x'),
                   (3, 'knowledge_graph', 'Knowledge Graph', true,  false, NULL),
                   (4, 'linkedin',        'LinkedIn',        true,  false, NULL)
            """
        )


@requires_test_db
async def test_list_connections_flags_and_token_hiding(
    api_client: httpx.AsyncClient, seeded_connections: None
) -> None:
    response = await api_client.get("/connections")
    assert response.status_code == 200
    rows = {row["name"]: row for row in response.json()["connections"]}

    assert "linkedin" not in rows, "retired providers are filtered out"
    assert set(rows) == {"github", "clickup", "knowledge_graph"}

    for row in rows.values():
        assert "accessToken" not in row, "the token must never be serialised"
        assert set(row) == {
            "id",
            "name",
            "label",
            "enabled",
            "oauthConnected",
            "createdAt",
            "updatedAt",
            "oauthSupported",
            "oauthConfigured",
            "apiKeySupported",
            "apiKeyConnected",
        }

    assert rows["github"]["oauthSupported"] is True
    assert rows["github"]["apiKeySupported"] is False

    # ClickUp uses a pasted key, stored in the same access_token column.
    assert rows["clickup"]["apiKeySupported"] is True
    assert rows["clickup"]["apiKeyConnected"] is True
    assert rows["clickup"]["oauthSupported"] is False

    # Not an OAuth provider at all.
    assert rows["knowledge_graph"]["oauthSupported"] is False
    assert rows["knowledge_graph"]["oauthConfigured"] is False


@requires_test_db
async def test_patch_enabled_validation(
    api_client: httpx.AsyncClient, seeded_connections: None
) -> None:
    ok = await api_client.patch("/connections/1", json={"enabled": False})
    assert ok.status_code == 200
    assert ok.json()["connection"]["enabled"] is False

    for bad in ({"enabled": "false"}, {"enabled": 0}, {}):
        response = await api_client.patch("/connections/1", json=bad)
        assert response.status_code == 400
        assert response.json() == {"error": "enabled must be a boolean"}

    missing = await api_client.patch("/connections/999", json={"enabled": True})
    assert missing.status_code == 404


@requires_test_db
async def test_api_key_only_for_api_key_providers(
    api_client: httpx.AsyncClient, seeded_connections: None
) -> None:
    rejected = await api_client.put("/connections/github/apikey", json={"apiKey": "x"})
    assert rejected.status_code == 400
    assert rejected.json() == {"error": "github does not use API key auth"}

    blank = await api_client.put("/connections/clickup/apikey", json={"apiKey": "  "})
    assert blank.status_code == 400
    assert blank.json() == {"error": "apiKey is required"}

    saved = await api_client.put("/connections/clickup/apikey", json={"apiKey": " pk_new "})
    assert saved.status_code == 200
    assert saved.json() == {"ok": True}

    removed = await api_client.delete("/connections/clickup/apikey")
    assert removed.status_code == 200
    listed = {r["name"]: r for r in (await api_client.get("/connections")).json()["connections"]}
    assert listed["clickup"]["apiKeyConnected"] is False


@requires_test_db
async def test_oauth_start_redirects_302(
    api_client: httpx.AsyncClient, seeded_connections: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SPOTIFY_OAUTH_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("SPOTIFY_OAUTH_CLIENT_SECRET", "test-secret")
    from app.config import get_settings

    get_settings.cache_clear()

    response = await api_client.get("/connections/spotify/oauth/start", follow_redirects=False)
    # 302, not FastAPI's default 307: the browser must issue a fresh GET.
    assert response.status_code == 302
    assert response.headers["location"].startswith("https://accounts.spotify.com/authorize?")

    unknown = await api_client.get("/connections/nope/oauth/start", follow_redirects=False)
    assert unknown.status_code == 400
    assert unknown.json() == {"error": 'No OAuth config for "nope"'}


@requires_test_db
async def test_oauth_callback_redirects_to_app(api_client: httpx.AsyncClient) -> None:
    from app.config import get_settings

    app_url = get_settings().app_url

    denied = await api_client.get(
        "/oauth/callback", params={"error": "access_denied"}, follow_redirects=False
    )
    assert denied.status_code == 302
    assert denied.headers["location"] == f"{app_url}/connections?oauth_error=access_denied"

    bare = await api_client.get("/oauth/callback", follow_redirects=False)
    assert bare.status_code == 302
    assert bare.headers["location"] == f"{app_url}/connections?oauth_error=missing_params"

    # An unknown state is rejected before any network call is attempted.
    stale = await api_client.get(
        "/oauth/callback", params={"code": "c", "state": "nope"}, follow_redirects=False
    )
    assert stale.status_code == 302
    assert "oauth_error=Invalid%20or%20expired%20OAuth%20state" in stale.headers["location"]


@requires_test_db
async def test_oauth_disconnect_clears_tokens(
    api_client: httpx.AsyncClient, seeded_connections: None
) -> None:
    response = await api_client.delete("/connections/github/oauth")
    assert response.status_code == 200
    assert response.json() == {"success": True}

    url = resolve_test_database_url()
    assert url is not None
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT access_token, refresh_token, token_expiry, oauth_connected "
            "FROM connections WHERE name = 'github'"
        )
        assert cur.fetchone() == (None, None, None, False)
