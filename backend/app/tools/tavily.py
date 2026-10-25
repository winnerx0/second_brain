"""Tavily web search — port of `src/tools/tavily.ts`.

Raw HTTP rather than `tavily-python`: the TypeScript hand-builds the request body and
re-keys the response into camelCase, and an SDK would change both the request shape
and the field names the agent sees.
"""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.http import get_client
from app.json import dumps
from app.logging import get_logger

logger = get_logger("tavily")

TAVILY_SEARCH_URL = "https://api.tavily.com/search"

SearchDepth = Literal["basic", "advanced", "fast", "ultra-fast"]
Topic = Literal["general", "news", "finance"]
TimeRange = Literal["day", "week", "month", "year", "d", "w", "m", "y"]


class TavilySearchArgs(BaseModel):
    query: str = Field(description="The web search query to execute.")
    search_depth: SearchDepth = Field(
        default="basic",
        description=(
            "Latency/relevance tradeoff. basic is the default; advanced costs more "
            "but can improve detailed queries."
        ),
    )
    topic: Topic = Field(
        default="general",
        description=(
            "Search category. Use news for current news, finance for finance "
            "queries, and general otherwise."
        ),
    )
    max_results: int = Field(
        default=5, ge=1, le=20, description="Maximum number of results to return."
    )
    time_range: TimeRange | None = Field(
        default=None,
        description="Optional freshness filter based on publish or update date.",
    )
    include_domains: list[str] | None = Field(
        default=None, description="Optional list of domains to limit results to."
    )
    exclude_domains: list[str] | None = Field(
        default=None, description="Optional list of domains to exclude from results."
    )


@tool("tavily_search", args_schema=TavilySearchArgs)
async def tavily_search(
    query: str,
    search_depth: SearchDepth = "basic",
    topic: Topic = "general",
    max_results: int = 5,
    time_range: TimeRange | None = None,
    include_domains: list[str] | None = None,
    exclude_domains: list[str] | None = None,
) -> str:
    """Search the live web using Tavily. Use this for current events, recent facts, external sources, and web lookups."""
    settings = get_settings()
    if not settings.TAVILY_API_KEY:
        return (
            "Tavily web search is not configured. Set TAVILY_API_KEY in the "
            "environment, then restart the app."
        )

    try:
        payload: dict[str, Any] = {
            "query": query,
            "search_depth": search_depth,
            "topic": topic,
            "max_results": max_results,
            "include_answer": "basic",
            "include_usage": True,
            "include_favicon": True,
        }
        # Omitted entirely when unset, as the TypeScript's conditional spreads did.
        if time_range:
            payload["time_range"] = time_range
        if include_domains:
            payload["include_domains"] = include_domains
        if exclude_domains:
            payload["exclude_domains"] = exclude_domains

        response = await get_client().post(
            TAVILY_SEARCH_URL,
            headers={
                "Authorization": f"Bearer {settings.TAVILY_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        if response.is_error:
            return f"Tavily search failed ({response.status_code}): {response.text}"

        data = response.json()
        if not isinstance(data, dict):
            data = {}

        return dumps(
            {
                "query": data.get("query") or query,
                "answer": data.get("answer"),
                "results": [
                    {
                        "title": result.get("title"),
                        "url": result.get("url"),
                        "content": result.get("content"),
                        "rawContent": result.get("raw_content"),
                        "score": result.get("score"),
                        "publishedDate": result.get("published_date"),
                    }
                    for result in (data.get("results") or [])
                ],
                "responseTime": data.get("response_time"),
                "creditsUsed": (data.get("usage") or {}).get("credits"),
                "requestId": data.get("request_id"),
            }
        )
    except Exception as exc:
        logger.error("[tavily]", exc_info=exc)
        return f"Error searching Tavily: {exc}"


tavily_tools = [tavily_search]
