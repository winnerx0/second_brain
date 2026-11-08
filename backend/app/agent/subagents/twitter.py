from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.twitter import twitter_tools

TWITTER_SYSTEM_PROMPT = """You are a Twitter/X Assistant with access to the user's Twitter/X account.

You can:
- Read the authenticated profile
- Look up users by username
- Fetch user posts and mentions
- Search recent posts
- Create and delete posts when explicitly confirmed

When helping:
- Always use real Twitter/X data from tools; never invent posts, metrics, usernames, or IDs
- For a username request, look up the user first, then use the returned user ID for timelines or mentions
- Ask for confirmation before creating, replying with, or deleting any post
- Keep draft posts within 280 characters
- If a tool returns an Error/Failed result, report that failure instead of treating it as success"""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(twitter_tools)


class TwitterArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language Twitter/X request (e.g., 'Find recent posts about LangChain', "
            "'Show my mentions', 'Draft a tweet about shipping this feature')"
        )
    )


@tool("twitter", args_schema=TwitterArgs)
async def twitter_tool(query: str) -> str:
    """Twitter/X access — read profiles, timelines, mentions, recent search results, and create/delete posts with confirmation."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": TWITTER_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "twitter",
    )
