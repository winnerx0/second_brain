"""Telegram tool — port of `src/tools/telegram.ts`."""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.delivery.telegram import send_telegram_message
from app.logging import get_logger

logger = get_logger("telegram")


class SendTelegramMessageArgs(BaseModel):
    message: str = Field(description="The message text to send through Telegram.")


@tool("send_telegram_message", args_schema=SendTelegramMessageArgs)
async def send_telegram_bot_message(message: str) -> str:
    """Send a message through the configured Telegram bot to the configured Telegram chat. Use only after the user has confirmed the final message text."""
    try:
        await send_telegram_message(message)
        return "Telegram message sent."
    except Exception as exc:
        logger.error("[telegram] sendTelegramBotMessage", exc_info=exc)
        return f"Error sending Telegram message: {exc}"


telegram_tools = [send_telegram_bot_message]
