from __future__ import annotations

from langchain_core.tools import BaseTool

from app.agent.subagents.anilist import anilist_tool
from app.agent.subagents.calendar import calendar_tool
from app.agent.subagents.clickup import clickup_tool
from app.agent.subagents.docs import docs_tool
from app.agent.subagents.github import github_tool
from app.agent.subagents.gmail import gmail_tool
from app.agent.subagents.knowledge_graph import knowledge_graph_tool
from app.agent.subagents.notion import notion_tool
from app.agent.subagents.spotify import spotify_tool
from app.agent.subagents.tavily import tavily_tool
from app.agent.subagents.twitter import twitter_tool
from app.tools.memory import memory_tools
from app.tools.miscellaneous import misc_tools
from app.tools.skills import skill_tools
from app.tools.telegram import telegram_tools

#: Specialist tool names the agent is expected to expose, in registration order.
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

#: Non-specialist tool names the agent is expected to expose.
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
        github_tool,
        calendar_tool,
        gmail_tool,
        docs_tool,
        anilist_tool,
        knowledge_graph_tool,
        notion_tool,
        clickup_tool,
        spotify_tool,
        twitter_tool,
        tavily_tool,
    ]


def missing_tool_names() -> list[str]:
    """Expected tools that are not wired yet."""
    wired = {tool.name for tool in main_agent_tools()}
    expected = {*EXPECTED_DIRECT_TOOLS, *EXPECTED_SPECIALISTS}
    return sorted(expected - wired)
