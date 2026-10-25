"""Chat endpoints — `src/app.ts:668-838`.

`POST /chat` serves two callers: the browser (a bare `{message}` or `{text}` body)
and Telegram webhooks (a full update object). Telegram updates are recognised by
`message` being an object, and are then checked against the configured chat id and
de-duplicated by `update_id`.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse

from app.agent.agent import handle_message
from app.config import get_settings
from app.delivery.telegram import send_telegram_message
from app.json import JsonResponse
from app.logging import get_logger
from app.sse import COMMENT_HEARTBEAT, SSE_HEADERS, SSE_MEDIA_TYPE, event_frame

router = APIRouter(tags=["chat"])
logger = get_logger("chat")

#: Heartbeat cadence for `/chat/stream`, matching the 5s `setInterval` it replaces.
HEARTBEAT_SECONDS = 5.0

#: Seen Telegram `update_id`s.
#:
#: In-process, as in the TypeScript, and therefore lost on restart and not shared
#: between workers — one more reason the server runs with a single worker. Moving
#: this to Postgres is a prerequisite for scaling out.
_processed_update_ids: set[int] = set()
_MAX_TRACKED_UPDATES = 10_000


def _incoming_text(body: dict[str, Any]) -> str:
    """`getIncomingChatText` — accepts `text`, `message`, or `message.text`."""
    if isinstance(body.get("text"), str):
        return body["text"]
    message = body.get("message")
    if isinstance(message, str):
        return message
    if isinstance(message, dict) and isinstance(message.get("text"), str):
        return message["text"]
    return ""


def _is_telegram_update(body: dict[str, Any]) -> bool:
    return isinstance(body.get("message"), dict)


def _is_allowed_telegram_chat(body: dict[str, Any]) -> bool:
    chat = (body.get("message") or {}).get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return False
    return str(chat_id) == str(get_settings().TELEGRAM_CHAT_ID)


def _is_duplicate_update(update_id: Any) -> bool:
    """De-duplicate Telegram retries. Non-integer ids are never duplicates."""
    if not isinstance(update_id, int) or isinstance(update_id, bool):
        return False
    if update_id in _processed_update_ids:
        return True
    _processed_update_ids.add(update_id)
    if len(_processed_update_ids) > _MAX_TRACKED_UPDATES:
        _processed_update_ids.clear()
    return False


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


@router.post("/chat")
async def chat(request: Request) -> Response:
    body = await _json_body(request)
    message = _incoming_text(body).strip()

    if not message:
        return JsonResponse({"success": False, "error": "Message text required"}, status_code=400)

    if _is_duplicate_update(body.get("update_id")):
        logger.warning(
            "[chat] duplicate message received with update_id: %s", body.get("update_id")
        )
        return JsonResponse({"success": False, "error": "Duplicate message"})

    if _is_telegram_update(body) and not _is_allowed_telegram_chat(body):
        logger.warning("[telegram] ignored message from unauthorized chat")
        return JsonResponse(
            {"success": False, "error": "Unauthorized Telegram chat"}, status_code=403
        )

    logger.info("[chat] received: %s", message)
    reply = await handle_message(message)

    if _is_telegram_update(body):
        await send_telegram_message(reply)

    return JsonResponse({"success": True, "reply": reply})


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> Response:
    """Always 200 — Telegram retries anything else, which would duplicate work."""
    body = await _json_body(request)
    message = _incoming_text(body).strip()

    if not message:
        return JsonResponse({"success": True, "ignored": True})

    if _is_duplicate_update(body.get("update_id")):
        logger.warning(
            "[telegram] duplicate update received with update_id: %s",
            body.get("update_id"),
        )
        return JsonResponse({"success": True, "duplicate": True})

    if _is_telegram_update(body) and not _is_allowed_telegram_chat(body):
        logger.warning("[telegram] ignored message from unauthorized chat")
        return JsonResponse({"success": True, "ignored": True})

    logger.info("[telegram] received: %s", message)
    reply = await handle_message(message)
    await send_telegram_message(reply)
    return JsonResponse({"success": True})


@router.post("/chat/stream")
async def chat_stream(request: Request) -> Response:
    """Stream the turn as SSE.

    The agent runs as a task feeding a queue, and the generator races the queue
    against the heartbeat interval — the TypeScript equivalent was a `setInterval`
    running alongside the agent promise. Starlette cancels this generator when the
    client disconnects, so the `finally` block is what replaces the `abort` listener
    on the request signal.
    """
    body = await _json_body(request)
    message = body.get("message") or body.get("text") or ""
    session_id = body.get("sessionId")
    if not isinstance(session_id, int) or isinstance(session_id, bool):
        session_id = None

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def sink(event: dict[str, Any]) -> None:
        await queue.put(event)

    async def run() -> None:
        try:
            await handle_message(message, on_event=sink, session_id=session_id)
        finally:
            await queue.put(None)

    async def generate():
        task = asyncio.create_task(run(), name="chat-stream")
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield COMMENT_HEARTBEAT
                    continue

                if event is None:
                    # The agent finished; surface a failure as an error event, since
                    # the response has already started and cannot become a 500.
                    if not task.cancelled() and task.exception() is not None:
                        yield event_frame({"type": "error", "message": str(task.exception())})
                    break

                yield event_frame(event)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    return StreamingResponse(generate(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)
