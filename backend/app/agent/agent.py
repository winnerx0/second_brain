from __future__ import annotations

import asyncio
import datetime as dt
import json
from collections.abc import Awaitable, Callable
from functools import lru_cache
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from sqlalchemy import text

from app.agent.context import StreamContext, subagent_stream_context
from app.agent.prompts import BRIEFING_SYSTEM_PROMPT, chat_system_prompt
from app.agent.registry import main_agent_tools
from app.agent.resilient import resilient_middleware
from app.agent.stream import StreamTranslator
from app.config import get_settings
from app.db.engine import session_scope
from app.delivery.telegram import send_telegram_message
from app.logging import get_logger
from app.memory.context import build_recall_context
from app.shared import get_model
from app.tools.skills import build_skills_system_prompt

logger = get_logger("agent")

#: Recursion limit for the briefing invoke.
BRIEFING_RECURSION_LIMIT = 25
#: Maximum rows loaded by the chat-history lookup.
HISTORY_LIMIT = 40

EventSink = Callable[[dict[str, Any]], Awaitable[None] | None]

_background: set[asyncio.Task[Any]] = set()


def spawn_background(coro: Any, *, name: str) -> asyncio.Task[Any]:
    task = asyncio.create_task(coro, name=name)
    _background.add(task)
    task.add_done_callback(_background.discard)
    return task


@lru_cache(maxsize=1)
def get_agent() -> Any:
    """The main agent graph.

    `resilient_middleware()` wraps every tool: a thrown
    tool error becomes a message for the model instead of halting the graph.
    """
    return create_agent(
        get_model(),
        tools=main_agent_tools(),
        middleware=resilient_middleware(),
    )


def _token_count(value: str) -> int:
    """`js-tiktoken` `getEncoding('cl100k_base')`, used only for log lines."""
    import tiktoken

    return len(tiktoken.get_encoding("cl100k_base").encode(value))


async def _with_skills_prompt(base: str) -> str:
    skills = await build_skills_system_prompt()
    return f"{base}\n\n{skills}" if skills else base


def _utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def reconstruct_history(rows: list[tuple[str, str]]) -> list[BaseMessage]:
    """Rebuild LangChain messages from `chat_history` rows.

    Rows arrive oldest-first. Orphaned `ToolMessage`s — ones whose preceding message
    is not an `AIMessage` carrying tool calls — are dropped, because a provider
    rejects a tool result that does not answer a tool call. That happens whenever a
    previous turn was interrupted mid-tool-call.
    """
    rebuilt: list[BaseMessage] = []
    for role, content in rows:
        try:
            data = json.loads(content)
        except ValueError:
            logger.warning("[chat] skipping unparseable history row")
            continue

        if role == "human":
            rebuilt.append(HumanMessage(content=data.get("content", "")))
        elif role == "tool":
            rebuilt.append(
                ToolMessage(
                    content=data.get("content", ""),
                    tool_call_id=data.get("tool_call_id", ""),
                    name=data.get("name"),
                )
            )
        else:
            tool_calls = data.get("tool_calls")
            rebuilt.append(
                AIMessage(
                    content=data.get("content", ""),
                    tool_calls=tool_calls if isinstance(tool_calls, list) else [],
                )
            )

    cleaned: list[BaseMessage] = []
    for message in rebuilt:
        if isinstance(message, ToolMessage):
            previous = cleaned[-1] if cleaned else None
            if isinstance(previous, AIMessage) and (previous.tool_calls or []):
                cleaned.append(message)
            # else: drop the orphan
        else:
            cleaned.append(message)
    return cleaned


def serialize_for_history(message: BaseMessage, session_id: int | None) -> dict[str, Any] | None:
    """Turn a message into a `chat_history` row, or None if it carries nothing."""
    if isinstance(message, ToolMessage):
        return {
            "session_id": session_id,
            "role": "tool",
            "content": json.dumps(
                {
                    "tool_call_id": message.tool_call_id,
                    "name": message.name,
                    "content": message.content,
                },
                separators=(",", ":"),
                ensure_ascii=False,
                default=str,
            ),
        }
    if isinstance(message, AIMessage):
        has_content = bool(message.content)
        has_tool_calls = bool(message.tool_calls)
        if not has_content and not has_tool_calls:
            return None
        return {
            "session_id": session_id,
            "role": "ai",
            "content": json.dumps(
                {"content": message.content, "tool_calls": message.tool_calls or []},
                separators=(",", ":"),
                ensure_ascii=False,
                default=str,
            ),
        }
    if isinstance(message, HumanMessage):
        return {
            "session_id": session_id,
            "role": "human",
            "content": json.dumps(
                {"content": message.content},
                separators=(",", ":"),
                ensure_ascii=False,
                default=str,
            ),
        }
    return None


async def _load_history(session_id: int | None) -> list[BaseMessage]:
    """The most recent `HISTORY_LIMIT` messages, oldest-first.

    A NULL `session_id` is the default session-less conversation, and is selected
    with `IS NULL` rather than an equality test.
    """
    clause = "session_id = :session_id" if session_id else "session_id IS NULL"
    async with session_scope() as session:
        rows = (
            await session.execute(
                text(
                    f"SELECT role, content FROM chat_history WHERE {clause} "
                    "ORDER BY id DESC LIMIT :limit"
                ),
                {"session_id": session_id, "limit": HISTORY_LIMIT}
                if session_id
                else {"limit": HISTORY_LIMIT},
            )
        ).all()
    # DESC for the limit, then reversed so the model sees chronological order.
    return reconstruct_history([(row.role, row.content) for row in reversed(rows)])


async def _persist(messages: list[BaseMessage], session_id: int | None, reply: str) -> None:
    rows = [
        row
        for row in (serialize_for_history(message, session_id) for message in messages)
        if row is not None
    ]
    # If the model answered without emitting a recordable AI message, store the reply
    # so the turn is not lost from history.
    if reply.strip() and not any(row["role"] == "ai" for row in rows):
        rows.append(
            {
                "session_id": session_id,
                "role": "ai",
                "content": json.dumps(
                    {"content": reply, "tool_calls": []},
                    separators=(",", ":"),
                    ensure_ascii=False,
                ),
            }
        )
    if not rows:
        return

    try:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO chat_history (session_id, role, content) "
                    "VALUES (:session_id, :role, :content)"
                ),
                rows,
            )
            if session_id:
                await session.execute(
                    text("UPDATE chat_sessions SET updated_at = :now WHERE id = :id"),
                    {"now": _utcnow_naive(), "id": session_id},
                )
    except Exception as exc:
        logger.error("[chat.save] failed to persist chat history", exc_info=exc)


async def handle_message(
    message: str,
    *,
    on_event: EventSink | None = None,
    session_id: int | None = None,
    debug_payloads: bool | None = None,
) -> str:
    """Run one chat turn, optionally streaming events, and return the reply."""
    settings = get_settings()
    logger.info("[chat] input: %s", message)

    history = await _load_history(session_id)
    base_prompt = await _with_skills_prompt(chat_system_prompt(settings.USER_TIMEZONE))

    # Proactive recall, so the agent answers from what it knows without having to
    # decide to call recall_memories first.
    recall = await build_recall_context(message)
    system_prompt = f"{base_prompt}\n\n{recall}" if recall else base_prompt

    logger.info("[chat] estimated input tokens: %d", _token_count(system_prompt + message))

    async def emit_event(event: dict[str, Any]) -> None:
        if on_event is None:
            return
        result = on_event(event)
        if result is not None and hasattr(result, "__await__"):
            await result

    await emit_event({"type": "status", "message": "Thinking..."})

    input_messages: list[BaseMessage] = [
        SystemMessage(content=system_prompt),
        *history,
        HumanMessage(content=message),
    ]

    translator = StreamTranslator(
        debug_payloads=(
            settings.AGENT_DEBUG_TOOL_PAYLOADS if debug_payloads is None else debug_payloads
        )
    )

    stream_ctx = StreamContext(on_event=on_event, debug_payloads=translator.debug_payloads)
    with subagent_stream_context(stream_ctx):
        async for chunk in get_agent().astream({"messages": input_messages}, stream_mode="updates"):
            for event in translator.translate(chunk):
                await emit_event(event)

    reply = translator.final_text()

    # The human message is part of this turn and is persisted alongside the new
    # messages, which is why 'human' rows exist at all.
    await _persist([input_messages[-1], *translator.messages], session_id, reply)

    logger.info("[chat] reply: %s", reply)
    await emit_event({"type": "final", "text": reply})

    if reply.strip():
        # Self-learning runs in the background so it never adds chat latency.
        # NOT YET IMPLEMENTED: app/memory/learn.py (conversation consolidation). Until it
        # lands, chat works but the memory graph stops growing on its own.
        pass

    return reply


async def run_briefing() -> str:
    """Generate the daily briefing, record it, and send it to Telegram."""
    system_prompt = await _with_skills_prompt(BRIEFING_SYSTEM_PROMPT)
    logger.info(
        "[briefing] estimated input tokens: %d",
        _token_count(system_prompt + "Generate my daily briefing now."),
    )

    response = await get_agent().ainvoke(
        {
            "messages": [
                SystemMessage(content=system_prompt),
                HumanMessage(content="Generate my daily briefing now."),
            ]
        },
        config={"recursion_limit": BRIEFING_RECURSION_LIMIT},
    )

    messages = response.get("messages") or []
    briefing = str(messages[-1].content) if messages else ""

    async with session_scope() as session:
        await session.execute(
            text(
                "INSERT INTO agent_runs (briefing_text, sources_fetched, success) "
                "VALUES (:text, :sources, true)"
            ),
            {"text": briefing, "sources": ["github", "calendar"]},
        )

    await send_telegram_message(briefing)
    return briefing
