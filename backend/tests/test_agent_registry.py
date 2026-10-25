"""Records which of the TypeScript agent's tools are wired, and which are not.

`src/agent.ts` exposed 21 tools. This test fails if a wired tool disappears, and its
`KNOWN_MISSING` list is the live checklist for the rest of the port — removing a name
from it without wiring the tool breaks the test.
"""

from __future__ import annotations

from app.agent.registry import (
    EXPECTED_DIRECT_TOOLS,
    EXPECTED_SPECIALISTS,
    main_agent_tools,
    missing_tool_names,
)

#: Still to port. Shrink this as each module lands; it must reach [] before cutover.
KNOWN_MISSING = [
    "anilist",
    "calendar",
    "clickup",
    "docs",
    "github",
    "gmail",
    "knowledge_graph",
    "list_workflows",
    "manage_workflow",
    "notion",
    "schedule_workflow",
    "spotify",
    "twitter",
]


def test_wired_tools_are_a_subset_of_the_typescript_surface() -> None:
    """No tool may be invented that the TypeScript agent did not expose."""
    expected = {*EXPECTED_DIRECT_TOOLS, *EXPECTED_SPECIALISTS}
    wired = {tool.name for tool in main_agent_tools()}
    assert wired <= expected, f"unexpected tools wired: {sorted(wired - expected)}"


def test_currently_wired_tools() -> None:
    assert sorted(tool.name for tool in main_agent_tools()) == [
        "delete_memory_key",
        "get_current_datetime",
        "list_skills",
        "read_skill",
        "recall_memories",
        "send_telegram_message",
        "set_memory_key",
        "web_search",
    ]


def test_remaining_gap_is_exactly_what_we_think_it_is() -> None:
    """Guards against both silent regressions and stale bookkeeping."""
    assert missing_tool_names() == KNOWN_MISSING


def test_every_tool_has_a_name_and_description() -> None:
    """Both are sent to the model; an empty one degrades tool selection silently."""
    for tool in main_agent_tools():
        assert tool.name, tool
        assert tool.description and tool.description.strip(), tool.name


def test_tool_names_are_unique() -> None:
    names = [tool.name for tool in main_agent_tools()]
    assert len(names) == len(set(names)), f"duplicate tool names: {names}"
