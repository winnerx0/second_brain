from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.tavily import tavily_tools

TAVILY_SYSTEM_PROMPT = """You are a Web Search Assistant with access to Tavily web search.

When helping:
- Use Tavily for live web lookups, recent facts, news, source discovery, and external references.
- Prefer concise queries. Use topic "news" for current events and "finance" for markets or company financial information.
- Use freshness filters when the user asks for latest, recent, today, this week, or another time-sensitive window.
- Always cite the source URLs you used in the final answer.
- Never invent sources or claim a source says something if it was not returned by the search tool.
- If Tavily is not configured or a search fails, report that failure clearly."""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(tavily_tools)


class WebSearchArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language web search request (e.g., 'Find the latest React "
            "release notes', 'What happened with OpenAI today?', 'Search official "
            "docs for Tavily auth')"
        )
    )


@tool("web_search", args_schema=WebSearchArgs)
async def tavily_tool(query: str) -> str:
    """Search the live web with Tavily for current information, recent facts, news, source discovery, or external references."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": TAVILY_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "tavily",
    )
