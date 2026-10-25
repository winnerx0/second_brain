"""Telegram delivery — port of `src/delivery/telegram.ts`.

Two behaviours matter and are preserved exactly:

* Telegram's legacy Markdown parser is strict and rejects text the agent happily
  produces. A 400 is retried once as plain text rather than surfaced as a failure.
* Messages are split at 4096 characters on paragraph, then line, boundaries, so a
  long briefing is not truncated.
"""

from __future__ import annotations

from app.config import get_settings
from app.http import get_client

MAX_LENGTH = 4096


def _api_base() -> str:
    return f"https://api.telegram.org/bot{get_settings().TELEGRAM_BOT_TOKEN}"


def split_message(text: str) -> list[str]:
    """Split into <=MAX_LENGTH chunks, preferring paragraph then line breaks."""
    if len(text) <= MAX_LENGTH:
        return [text]

    chunks: list[str] = []
    current = ""

    for paragraph in text.split("\n\n"):
        if len(paragraph) > MAX_LENGTH:
            if current:
                chunks.append(current.strip())
            current = ""
            for line in paragraph.split("\n"):
                if len(current + "\n" + line) > MAX_LENGTH:
                    if current:
                        chunks.append(current.strip())
                    current = line
                else:
                    current = current + "\n" + line if current else line
        elif len(current + "\n\n" + paragraph) > MAX_LENGTH:
            if current:
                chunks.append(current.strip())
            current = paragraph
        else:
            current = current + "\n\n" + paragraph if current else paragraph

    if current:
        chunks.append(current.strip())
    return chunks


async def _send_one(text: str) -> None:
    settings = get_settings()
    client = get_client()
    payload = {
        "chat_id": settings.TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
    }
    response = await client.post(f"{_api_base()}/sendMessage", json=payload)

    if response.status_code == 400:
        # Markdown parse failure — resend without formatting.
        response = await client.post(
            f"{_api_base()}/sendMessage",
            json={"chat_id": settings.TELEGRAM_CHAT_ID, "text": text},
        )

    if response.is_error:
        raise RuntimeError(f"Telegram API {response.status_code}: {response.text}")


async def send_telegram_message(text: str) -> None:
    for chunk in split_message(text):
        await _send_one(chunk)
