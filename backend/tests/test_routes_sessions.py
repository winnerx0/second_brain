from __future__ import annotations

import re

import httpx

from tests.conftest import requires_test_db

# JavaScript `Date` ISO format — three fractional digits, always `Z`.
JS_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@requires_test_db
async def test_health_shape(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"status", "timestamp"}
    assert body["status"] == "ok"
    assert isinstance(body["timestamp"], int), "Date.now() is integer milliseconds"
    assert body["timestamp"] > 1_600_000_000_000


@requires_test_db
async def test_sessions_crud_and_field_names(api_client: httpx.AsyncClient) -> None:
    empty = await api_client.get("/sessions")
    assert empty.status_code == 200
    assert empty.json() == {"sessions": []}

    created = await api_client.post("/sessions", json={"title": "  Trip planning  "})
    assert created.status_code == 201, created.text
    session = created.json()["session"]
    assert set(session) == {"id", "title", "createdAt", "updatedAt"}
    assert session["title"] == "Trip planning", "title is trimmed"
    assert JS_TIMESTAMP.match(session["createdAt"]), session["createdAt"]

    # An absent or blank title falls back to 'New Chat'.
    for payload in ({}, {"title": "   "}, None):
        default_titled = await api_client.post("/sessions", json=payload)
        assert default_titled.status_code == 201
        assert default_titled.json()["session"]["title"] == "New Chat"

    listed = await api_client.get("/sessions")
    assert len(listed.json()["sessions"]) == 4

    history = await api_client.get(f"/sessions/{session['id']}/history")
    assert history.status_code == 200
    assert history.json() == {"messages": []}

    deleted = await api_client.delete(f"/sessions/{session['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"success": True}
    assert len((await api_client.get("/sessions")).json()["sessions"]) == 3


@requires_test_db
async def test_invalid_session_id_is_400_not_422(api_client: httpx.AsyncClient) -> None:
    """A non-positive-integer id must produce a 400.

    A FastAPI `int` path parameter would return 422 with a different body, which
    `web/`'s error handling does not expect.
    """
    for bad in ("abc", "0", "-1", "1.5"):
        response = await api_client.get(f"/sessions/{bad}/history")
        assert response.status_code == 400, f"{bad} -> {response.status_code}"
        assert response.json() == {"error": "Invalid session id"}

        response = await api_client.delete(f"/sessions/{bad}")
        assert response.status_code == 400, f"{bad} -> {response.status_code}"
