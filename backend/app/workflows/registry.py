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

#: Add an entry as each specialist lands; `app/workflows/catalog.py` tracks the gap.
SPECIALISTS: dict[str, BaseTool] = {
    "github": github_tool,
    "calendar": calendar_tool,
    "gmail": gmail_tool,
    "docs": docs_tool,
    "anilist": anilist_tool,
    "knowledge_graph": knowledge_graph_tool,
    "notion": notion_tool,
    "clickup": clickup_tool,
    "spotify": spotify_tool,
    "twitter": twitter_tool,
    "web_search": tavily_tool,
}
