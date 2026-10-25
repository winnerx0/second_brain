"""Tests for chat-history reconstruction.

`chat_history` rows written by the TypeScript predate this port and must still load.
A provider rejects a tool result that does not answer a tool call, so the
orphan-dropping is what keeps a conversation usable after a turn was interrupted
mid-tool-call.
"""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.agent.agent import reconstruct_history, serialize_for_history


def _ai_row(content: str, tool_calls: list[dict] | None = None) -> tuple[str, str]:
    return ("ai", json.dumps({"content": content, "tool_calls": tool_calls or []}))


def _human_row(content: str) -> tuple[str, str]:
    return ("human", json.dumps({"content": content}))


def _tool_row(content: str, call_id: str, name: str | None = None) -> tuple[str, str]:
    return ("tool", json.dumps({"content": content, "tool_call_id": call_id, "name": name}))


CALL = {"name": "web_search", "args": {"query": "x"}, "id": "c1", "type": "tool_call"}


def test_roles_map_to_message_types() -> None:
    messages = reconstruct_history(
        [_human_row("hi"), _ai_row("", [CALL]), _tool_row("result", "c1", "web_search")]
    )
    assert [type(m).__name__ for m in messages] == [
        "HumanMessage",
        "AIMessage",
        "ToolMessage",
    ]
    assert messages[1].tool_calls[0]["id"] == "c1"
    assert messages[2].tool_call_id == "c1"
    assert messages[2].name == "web_search"


def test_orphaned_tool_message_is_dropped() -> None:
    """A tool result with no preceding tool call would be rejected by the provider."""
    messages = reconstruct_history([_human_row("hi"), _tool_row("stray", "c9")])
    assert [type(m).__name__ for m in messages] == ["HumanMessage"]


def test_tool_message_after_a_plain_ai_message_is_dropped() -> None:
    """The preceding AIMessage must actually carry tool_calls, not just exist."""
    messages = reconstruct_history([_ai_row("just text", []), _tool_row("stray", "c9")])
    assert [type(m).__name__ for m in messages] == ["AIMessage"]


def test_consecutive_tool_messages_after_one_call_keep_the_first_only() -> None:
    """Each kept ToolMessage becomes the new 'previous', so only the first survives.

    This mirrors the TypeScript exactly: it checks `history[history.length - 1]`,
    which is a ToolMessage by the time the second one is examined.
    """
    messages = reconstruct_history(
        [_ai_row("", [CALL]), _tool_row("a", "c1"), _tool_row("b", "c2")]
    )
    assert [type(m).__name__ for m in messages] == ["AIMessage", "ToolMessage"]
    assert messages[1].content == "a"


def test_unparseable_rows_are_skipped_not_fatal() -> None:
    messages = reconstruct_history([("human", "not json"), _human_row("ok")])
    assert len(messages) == 1
    assert messages[0].content == "ok"


def test_missing_tool_calls_field_defaults_to_empty() -> None:
    """Older rows may predate the tool_calls field."""
    messages = reconstruct_history([("ai", json.dumps({"content": "hello"}))])
    assert messages[0].tool_calls == []


def test_serialize_round_trips_through_reconstruct() -> None:
    original = [
        HumanMessage(content="what are my PRs?"),
        AIMessage(content="", tool_calls=[CALL]),
        ToolMessage(content="PR #1", tool_call_id="c1", name="web_search"),
        AIMessage(content="You have one."),
    ]
    rows = [serialize_for_history(m, session_id=3) for m in original]
    assert all(row is not None for row in rows)
    assert {row["session_id"] for row in rows} == {3}  # type: ignore[index]
    assert [row["role"] for row in rows] == ["human", "ai", "tool", "ai"]  # type: ignore[index]

    restored = reconstruct_history([(r["role"], r["content"]) for r in rows])  # type: ignore[index]
    assert [type(m).__name__ for m in restored] == [type(m).__name__ for m in original]
    assert restored[0].content == "what are my PRs?"
    assert restored[1].tool_calls[0]["name"] == "web_search"
    assert restored[2].content == "PR #1"
    assert restored[3].content == "You have one."


def test_empty_ai_message_is_not_persisted() -> None:
    """No content and no tool calls means there is nothing to record."""
    assert serialize_for_history(AIMessage(content=""), session_id=None) is None
    assert serialize_for_history(AIMessage(content="", tool_calls=[CALL]), None) is not None


def test_session_id_none_is_preserved() -> None:
    """NULL session_id is the default session-less conversation, not a missing value."""
    row = serialize_for_history(HumanMessage(content="hi"), session_id=None)
    assert row is not None
    assert row["session_id"] is None
