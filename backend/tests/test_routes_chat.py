from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conftest import requires_test_db


@pytest.fixture
def stub_agent(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace the agent with a scripted event emitter."""
    calls: dict[str, Any] = {"messages": [], "session_ids": []}

    async def fake_handle_message(
        message: str,
        *,
        on_event: Any = None,
        session_id: int | None = None,
        debug_payloads: bool | None = None,
    ) -> str:
        calls["messages"].append(message)
        calls["session_ids"].append(session_id)
        if on_event is not None:
            await on_event({"type": "status", "message": "Thinking..."})
            await on_event({"type": "tool_start", "tool": "web_search", "input": "{}"})
            await on_event({"type": "tool_end", "tool": "web_search"})
            await on_event({"type": "assistant_delta", "delta": "Hello"})
            await on_event({"type": "final", "text": "Hello"})
        return "Hello"

    monkeypatch.setattr("app.routes.chat.handle_message", fake_handle_message)
    return calls


@pytest.fixture
def captured_telegram(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    sent: list[str] = []

    async def fake_send(text: str) -> None:
        sent.append(text)

    monkeypatch.setattr("app.routes.chat.send_telegram_message", fake_send)
    return sent


@requires_test_db
async def test_chat_accepts_message_or_text(
    api_client: httpx.AsyncClient, stub_agent: dict[str, Any]
) -> None:
    for payload in ({"message": "hi there"}, {"text": "hi there"}):
        response = await api_client.post("/chat", json=payload)
        assert response.status_code == 200
        assert response.json() == {"success": True, "reply": "Hello"}
    assert stub_agent["messages"] == ["hi there", "hi there"]


@requires_test_db
async def test_chat_requires_text(
    api_client: httpx.AsyncClient, stub_agent: dict[str, Any]
) -> None:
    response = await api_client.post("/chat", json={"message": "   "})
    assert response.status_code == 400
    assert response.json() == {"success": False, "error": "Message text required"}


@requires_test_db
async def test_telegram_update_must_match_the_configured_chat(
    api_client: httpx.AsyncClient,
    stub_agent: dict[str, Any],
    captured_telegram: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "4242")
    from app.config import get_settings

    get_settings.cache_clear()

    wrong = await api_client.post(
        "/chat", json={"message": {"text": "hi", "chat": {"id": 1}}, "update_id": 1}
    )
    assert wrong.status_code == 403
    assert wrong.json() == {"success": False, "error": "Unauthorized Telegram chat"}
    assert captured_telegram == []

    # The id is compared as a string, so a numeric and a string id both match.
    right = await api_client.post(
        "/chat", json={"message": {"text": "hi", "chat": {"id": "4242"}}, "update_id": 2}
    )
    assert right.status_code == 200
    assert captured_telegram == ["Hello"], "a Telegram-shaped request also gets a reply"


@requires_test_db
async def test_duplicate_update_ids_are_dropped(
    api_client: httpx.AsyncClient, stub_agent: dict[str, Any]
) -> None:
    first = await api_client.post("/chat", json={"text": "hi", "update_id": 99_001})
    assert first.json() == {"success": True, "reply": "Hello"}

    repeat = await api_client.post("/chat", json={"text": "hi", "update_id": 99_001})
    assert repeat.status_code == 200
    assert repeat.json() == {"success": False, "error": "Duplicate message"}
    assert len(stub_agent["messages"]) == 1, "the agent must run only once"


@requires_test_db
async def test_telegram_webhook_always_returns_200(
    api_client: httpx.AsyncClient,
    stub_agent: dict[str, Any],
    captured_telegram: list[str],
) -> None:
    """Telegram retries any non-200, which would duplicate the work."""
    empty = await api_client.post("/telegram/webhook", json={})
    assert empty.status_code == 200
    assert empty.json() == {"success": True, "ignored": True}

    unauthorized = await api_client.post(
        "/telegram/webhook",
        json={"message": {"text": "hi", "chat": {"id": -1}}, "update_id": 77},
    )
    assert unauthorized.status_code == 200
    assert unauthorized.json() == {"success": True, "ignored": True}

    duplicate = await api_client.post("/telegram/webhook", json={"text": "hi", "update_id": 88})
    assert duplicate.status_code == 200
    again = await api_client.post("/telegram/webhook", json={"text": "hi", "update_id": 88})
    assert again.json() == {"success": True, "duplicate": True}


@requires_test_db
async def test_chat_stream_frames_and_headers(
    api_client: httpx.AsyncClient, stub_agent: dict[str, Any]
) -> None:
    async with api_client.stream(
        "POST", "/chat/stream", json={"text": "hi", "sessionId": 7}
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
        # Without this nginx buffers the whole stream and chat appears to hang.
        assert response.headers["x-accel-buffering"] == "no"
        assert response.headers["cache-control"] == "no-cache, no-transform"
        body = b"".join([chunk async for chunk in response.aiter_bytes()])

    text = body.decode()
    # The event name is the payload's own `type`, and the payload repeats in `data`.
    assert 'event: status\ndata: {"type":"status","message":"Thinking..."}\n\n' in text
    assert 'event: tool_start\ndata: {"type":"tool_start","tool":"web_search"' in text
    assert 'event: assistant_delta\ndata: {"type":"assistant_delta","delta":"Hello"}' in text
    assert 'event: final\ndata: {"type":"final","text":"Hello"}\n\n' in text
    # sessionId is threaded through to the agent.
    assert stub_agent["session_ids"] == [7]


@requires_test_db
async def test_chat_stream_reports_agent_failure_as_an_event(
    api_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The response has already started, so a failure cannot become a 500."""

    async def boom(
        _message: str,
        *,
        on_event: Any = None,
        session_id: int | None = None,
        debug_payloads: bool | None = None,
    ) -> str:
        if on_event is not None:
            await on_event({"type": "status", "message": "Thinking..."})
        raise RuntimeError("model unavailable")

    monkeypatch.setattr("app.routes.chat.handle_message", boom)

    async with api_client.stream("POST", "/chat/stream", json={"text": "hi"}) as response:
        assert response.status_code == 200
        body = b"".join([chunk async for chunk in response.aiter_bytes()]).decode()

    assert 'event: error\ndata: {"type":"error","message":"model unavailable"}' in body
