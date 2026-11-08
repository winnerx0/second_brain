from __future__ import annotations

from typing import Any

from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from app.agent.stream import StreamTranslator


class _ScriptedModel(GenericFakeChatModel):
    """`create_agent` calls `bind_tools`; the script already decides the calls."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self


@tool("get_open_prs")
async def _get_open_prs(owner: str) -> str:
    """Get open pull requests for an owner."""
    return "PR #1: fix things"


async def test_real_agent_stream_produces_expected_event_sequence() -> None:
    """A tool-calling turn must yield tool_start -> tool_end -> assistant_delta."""
    model = _ScriptedModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "get_open_prs",
                            "args": {"owner": "winnerx0"},
                            "id": "call_1",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="You have one open PR."),
            ]
        )
    )
    agent = create_agent(model, tools=[_get_open_prs])
    translator = StreamTranslator(debug_payloads=True)

    events: list[dict[str, Any]] = []
    async for chunk in agent.astream(
        {"messages": [HumanMessage("any PRs?")]}, stream_mode="updates"
    ):
        # The contract the translator relies on: one updated node per chunk, whose
        # value carries a `messages` list.
        assert len(chunk) == 1, chunk
        node_update = next(iter(chunk.values()))
        assert isinstance(node_update, dict) and "messages" in node_update, node_update
        events.extend(translator.translate(chunk))

    assert [e["type"] for e in events] == ["tool_start", "tool_end", "assistant_delta"]
    assert events[0]["tool"] == "get_open_prs"
    assert events[0]["input"] == '{"owner":"winnerx0"}', "compact JSON"
    assert events[1]["tool"] == "get_open_prs"
    assert events[1]["output"] == "PR #1: fix things"
    assert events[2]["delta"] == "You have one open PR."
    assert translator.final_text() == "You have one open PR."


def test_tool_end_name_falls_back_to_the_requesting_call() -> None:
    """A ToolMessage without `name` is matched to its AIMessage tool_call id."""
    translator = StreamTranslator()
    list(
        translator.translate(
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "search_notion",
                                    "args": {},
                                    "id": "abc",
                                    "type": "tool_call",
                                }
                            ],
                        )
                    ]
                }
            }
        )
    )
    events = list(
        translator.translate(
            {"tools": {"messages": [ToolMessage(content="ok", tool_call_id="abc")]}}
        )
    )
    assert events == [{"type": "tool_end", "tool": "search_notion"}]


def test_unknown_tool_call_id_degrades_to_tool() -> None:
    translator = StreamTranslator()
    events = list(
        translator.translate(
            {"tools": {"messages": [ToolMessage(content="ok", tool_call_id="missing")]}}
        )
    )
    assert events == [{"type": "tool_end", "tool": "tool"}]


def test_output_is_omitted_unless_debug_payloads() -> None:
    """`AGENT_DEBUG_TOOL_PAYLOADS` gates tool output; it is off by default."""
    translator = StreamTranslator(debug_payloads=False)
    events = list(
        translator.translate(
            {"tools": {"messages": [ToolMessage(content="secret", tool_call_id="x")]}}
        )
    )
    assert events == [{"type": "tool_end", "tool": "tool"}]
    assert "output" not in events[0]


def test_subagent_prefix_is_applied() -> None:
    """Subagents report inner tools as '<subagent>:<tool>'."""
    translator = StreamTranslator(tool_prefix="github:")
    events = list(
        translator.translate(
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "get_commits",
                                    "args": {"repo": "x"},
                                    "id": "1",
                                    "type": "tool_call",
                                }
                            ],
                        )
                    ]
                }
            }
        )
    )
    assert events[0]["tool"] == "github:get_commits"


def test_block_content_is_not_emitted_as_a_delta() -> None:
    """Only plain string content becomes a delta, only."""
    translator = StreamTranslator()
    events = list(
        translator.translate(
            {"model": {"messages": [AIMessage(content=[{"type": "text", "text": "hello"}])]}}
        )
    )
    assert events == []
    # ...but final_text still flattens blocks, regardless.
    assert translator.final_text() == "hello"


def test_empty_and_malformed_chunks_are_skipped() -> None:
    translator = StreamTranslator()
    assert list(translator.translate({})) == []
    assert list(translator.translate({"model": None})) == []  # type: ignore[dict-item]
    assert list(translator.translate({"model": {}})) == []
    assert list(translator.translate({"model": {"messages": "nope"}})) == []
    assert translator.final_text() == ""
