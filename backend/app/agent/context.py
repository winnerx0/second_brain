"""Ambient per-request context for the agent — port of `src/subagents/utils.ts`'s
`AsyncLocalStorage`.

`contextvars.ContextVar` is the direct analogue: a value set before an `await` chain
is visible to everything below it, and `asyncio.create_task` copies the current
context into the new task, which is what `AsyncLocalStorage.run()` gives you across
promise chains.

The one behavioural difference worth knowing: a `set()` inside a child task does not
propagate back to the parent. That is fine here, because both stores are written once
at the boundary and only read inward.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal, TypedDict


class ToolStartEvent(TypedDict, total=False):
    type: Literal["tool_start"]
    tool: str
    input: str | None


class ToolEndEvent(TypedDict, total=False):
    type: Literal["tool_end"]
    tool: str
    output: str | None


SubagentStreamEvent = ToolStartEvent | ToolEndEvent

EventSink = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass
class StreamContext:
    """Where nested tool-call events go, and whether to include their payloads."""

    on_event: EventSink | None = None
    debug_payloads: bool = False


_stream_context: ContextVar[StreamContext | None] = ContextVar(
    "subagent_stream_context", default=None
)


@contextmanager
def subagent_stream_context(ctx: StreamContext) -> Iterator[None]:
    """`runWithSubagentStreamContext` — scope an event sink over nested agent work."""
    token = _stream_context.set(ctx)
    try:
        yield
    finally:
        _stream_context.reset(token)


def current_stream_context() -> StreamContext | None:
    return _stream_context.get()


async def emit(event: dict[str, Any]) -> None:
    """Deliver an event to the ambient sink, if any. Sinks may be sync or async."""
    ctx = _stream_context.get()
    if ctx is None or ctx.on_event is None:
        return
    result = ctx.on_event(event)
    if result is not None and hasattr(result, "__await__"):
        await result


def safe_stringify(value: Any) -> str:
    """`safeStringify` — strings pass through, everything else is compact JSON."""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)
