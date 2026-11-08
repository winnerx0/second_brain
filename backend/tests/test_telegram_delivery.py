from __future__ import annotations

import httpx
import pytest

from app.delivery.telegram import MAX_LENGTH, send_telegram_message, split_message


def test_short_message_is_not_split() -> None:
    assert split_message("hello") == ["hello"]


def test_splits_on_paragraph_boundaries() -> None:
    para = "x" * 3000
    chunks = split_message(f"{para}\n\n{para}")
    assert len(chunks) == 2
    assert all(len(c) <= MAX_LENGTH for c in chunks)


def test_splits_on_line_boundaries_when_a_paragraph_is_too_long() -> None:
    line = "y" * 2000
    oversized = "\n".join([line] * 4)
    chunks = split_message(oversized)
    assert len(chunks) > 1
    assert all(len(c) <= MAX_LENGTH for c in chunks)
    # Nothing is lost, only whitespace at the joins.
    assert "".join(c.replace("\n", "") for c in chunks) == oversized.replace("\n", "")


def test_single_oversized_line_is_still_emitted() -> None:
    """A 10k-character line has no split point; it must not vanish."""
    chunks = split_message("z" * 10_000)
    assert chunks and "".join(chunks) == "z" * 10_000


async def test_markdown_parse_failure_retries_as_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Telegram's legacy Markdown is strict; a 400 is resent without parse_mode."""
    calls: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(request.content)
        calls.append(body)
        if "parse_mode" in body:
            return httpx.Response(400, json={"description": "can't parse entities"})
        return httpx.Response(200, json={"ok": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.delivery.telegram.get_client", lambda: client)

    await send_telegram_message("*unbalanced")

    assert len(calls) == 2
    assert calls[0]["parse_mode"] == "Markdown"
    assert "parse_mode" not in calls[1], "the retry drops formatting"
    assert calls[1]["text"] == "*unbalanced"
    await client.aclose()


async def test_non_400_failure_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream boom")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.delivery.telegram.get_client", lambda: client)

    with pytest.raises(RuntimeError, match="Telegram API 500"):
        await send_telegram_message("hi")
    await client.aclose()
