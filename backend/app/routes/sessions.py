"""Chat session endpoints — `src/app.ts:182-297`.

Response field names are camelCase because the TypeScript selected whole Drizzle
rows, and Drizzle maps columns to its own camelCase field names. `web/` reads
`createdAt`/`updatedAt`/`sessionId` directly, so the casing is part of the contract.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from sqlalchemy import delete, select

from app.db.engine import session_scope
from app.db.models import ChatHistory, ChatSession
from app.errors import BadRequestError
from app.json import JsonResponse
from app.logging import get_logger

router = APIRouter(tags=["sessions"])
logger = get_logger("sessions")


def _session_json(row: ChatSession) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


def _message_json(row: ChatHistory) -> dict[str, Any]:
    return {
        "id": row.id,
        "sessionId": row.session_id,
        "role": row.role,
        "content": row.content,
        "createdAt": row.created_at,
    }


def _session_id(raw: str) -> int:
    """Hono validated with `Number.isInteger(n) && n > 0`, returning 400 otherwise.

    The path parameter is declared as `str` so this returns 400 rather than FastAPI's
    default 422 for a non-numeric segment.
    """
    try:
        value = int(raw)
    except ValueError:
        raise BadRequestError("Invalid session id") from None
    if value <= 0:
        raise BadRequestError("Invalid session id")
    return value


@router.get("/sessions")
async def list_sessions() -> Response:
    try:
        async with session_scope() as session:
            rows = (
                await session.execute(select(ChatSession).order_by(ChatSession.updated_at.desc()))
            ).scalars()
            return JsonResponse({"sessions": [_session_json(row) for row in rows]})
    except Exception as exc:
        logger.error("[sessions.list] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to list sessions"}, status_code=500)


@router.post("/sessions", status_code=201)
async def create_session(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw_title = body.get("title") if isinstance(body, dict) else None
    title = raw_title.strip() if isinstance(raw_title, str) else ""
    try:
        async with session_scope() as session:
            created = ChatSession(title=title or "New Chat")
            session.add(created)
            await session.flush()
            payload = _session_json(created)
        return JsonResponse({"session": payload}, status_code=201)
    except Exception as exc:
        logger.error("[sessions.create] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to create session"}, status_code=500)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> Response:
    value = _session_id(session_id)
    try:
        async with session_scope() as session:
            # `chat_history.session_id` has no foreign key, so the rows are removed
            # explicitly, exactly as `src/app.ts` did.
            await session.execute(delete(ChatHistory).where(ChatHistory.session_id == value))
            await session.execute(delete(ChatSession).where(ChatSession.id == value))
        return JsonResponse({"success": True})
    except Exception as exc:
        logger.error("[sessions.delete] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to delete session"}, status_code=500)


@router.get("/sessions/{session_id}/history")
async def session_history(session_id: str) -> Response:
    value = _session_id(session_id)
    try:
        async with session_scope() as session:
            rows = (
                await session.execute(
                    select(ChatHistory)
                    .where(ChatHistory.session_id == value)
                    .order_by(ChatHistory.id.asc())
                )
            ).scalars()
            return JsonResponse({"messages": [_message_json(row) for row in rows]})
    except Exception as exc:
        logger.error("[sessions.history] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to load chat history"}, status_code=500)
