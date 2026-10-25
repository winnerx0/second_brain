"""The main agent's tool list.

Kept separate from `app/agent/agent.py` so the remaining specialists can be added
without touching the agent itself, and so tests can assert which tools are wired.

`src/agent.ts` registered, in order: get_current_datetime, the three workflow tools,
the three memory tools, the two skill tools, send_telegram_message, and then eleven
specialist-as-tool wrappers (github, calendar, gmail, docs, anilist,
knowledge_graph, notion, clickup, spotify, twitter, tavily).

PORTING STATUS — specialists still to land:
    github, calendar, gmail, docs, anilist, knowledge_graph, notion, clickup,
    spotify, twitter
and the workflow tools (schedule_workflow, list_workflows, manage_workflow), which
arrive with the workflow engine. Each is a one-line addition below once its module
exists; `tests/test_agent_registry.py` records the gap so it cannot be forgotten.
"""

from __future__ import annotations

from langchain_core.tools import BaseTool

from app.agent.subagents.tavily import tavily_tool
from app.tools.memory import memory_tools
from app.tools.miscellaneous import misc_tools
from app.tools.skills import skill_tools
from app.tools.telegram import telegram_tools

#: Specialist tool names the TypeScript agent exposed, in registration order.
EXPECTED_SPECIALISTS: tuple[str, ...] = (
    "github",
    "calendar",
    "gmail",
    "docs",
    "anilist",
    "knowledge_graph",
    "notion",
    "clickup",
    "spotify",
    "twitter",
    "web_search",
)

#: Non-specialist tool names the TypeScript agent exposed.
EXPECTED_DIRECT_TOOLS: tuple[str, ...] = (
    "get_current_datetime",
    "schedule_workflow",
    "list_workflows",
    "manage_workflow",
    "set_memory_key",
    "delete_memory_key",
    "recall_memories",
    "list_skills",
    "read_skill",
    "send_telegram_message",
)


def main_agent_tools() -> list[BaseTool]:
    """Every tool currently wired into the main agent."""
    return [
        *misc_tools,
        *memory_tools,
        *skill_tools,
        *telegram_tools,
        tavily_tool,
    ]


def missing_tool_names() -> list[str]:
    """Tools the TypeScript agent had that are not wired yet."""
    wired = {tool.name for tool in main_agent_tools()}
    expected = {*EXPECTED_DIRECT_TOOLS, *EXPECTED_SPECIALISTS}
    return sorted(expected - wired)
