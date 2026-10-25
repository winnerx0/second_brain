"""Translating agent stream chunks into the SSE events `web/` renders.

`src/agent.ts` consumed `agent.stream(..., {streamMode: 'updates'})` and took
`Object.entries(chunk)[0]` — the single updated node per chunk. LangGraph's Python
`astream(stream_mode="updates")` yields the same shape, `{node_name: {"messages":
[...]}}`, so the translation is mechanical. It is isolated here because the chunk
shape is the least stable thing in the port: it is the one place where a LangChain
version difference would silently stop `web/` rendering tool activity, and keeping it
pure makes it testable without a model.

The event union mirrors `AgentStreamEvent` in `src/agent.ts`; `web/src/routes/index.tsx`
switches on `type`.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from app.agent.context import safe_stringify


class StreamTranslator:
    """Stateful across a single agent run, because `tool_end` needs the name.

    A `ToolMessage` does not always carry `name`, so the tool name is remembered from
    the `AIMessage.tool_calls` entry that requested it, keyed by `tool_call_id` —
    exactly the `toolRunNames` map in `src/agent.ts`.
    """

    def __init__(self, *, debug_payloads: bool = False, tool_prefix: str = "") -> None:
        self.debug_payloads = debug_payloads
        #: Subagents prefix their inner tools as "<subagent>:<tool>".
        self.tool_prefix = tool_prefix
        self.tool_run_names: dict[str, str] = {}
        self.messages: list[BaseMessage] = []

    def _name(self, tool: str) -> str:
        return f"{self.tool_prefix}{tool}" if self.tool_prefix else tool

    def chunk_messages(self, chunk: dict[str, Any]) -> list[BaseMessage]:
        """The messages from a chunk's single updated node.

        `Object.entries(chunk)[0]` in the TypeScript: one node update per chunk, and
        an empty chunk is skipped.
        """
        if not chunk:
            return []
        _node, update = next(iter(chunk.items()))
        if not isinstance(update, dict):
            return []
        messages = update.get("messages")
        return list(messages) if isinstance(messages, list) else []

    def translate(self, chunk: dict[str, Any]) -> Iterator[dict[str, Any]]:
        """Emit the events for one chunk, recording its messages as a side effect."""
        for message in self.chunk_messages(chunk):
            self.messages.append(message)

            if isinstance(message, AIMessage):
                for call in message.tool_calls or []:
                    call_id = call.get("id")
                    name = call.get("name", "tool")
                    if call_id:
                        self.tool_run_names[call_id] = name
                    yield {
                        "type": "tool_start",
                        "tool": self._name(name),
                        "input": safe_stringify(call.get("args")),
                    }
                # Only plain string content becomes a delta; a content-block list is
                # reasoning/tool-use scaffolding and was skipped in the TypeScript too.
                if isinstance(message.content, str) and message.content:
                    yield {"type": "assistant_delta", "delta": message.content}

            elif isinstance(message, ToolMessage):
                name = message.name or self.tool_run_names.get(str(message.tool_call_id)) or "tool"
                event: dict[str, Any] = {"type": "tool_end", "tool": self._name(name)}
                if self.debug_payloads:
                    event["output"] = safe_stringify(message.content)
                yield event

    def final_text(self) -> str:
        """`getFinalText` — the last message's text, flattening content blocks."""
        if not self.messages:
            return ""
        content = self.messages[-1].content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and "text" in part:
                    parts.append(str(part["text"]))
            return "".join(parts)
        return "" if content is None else str(content)
