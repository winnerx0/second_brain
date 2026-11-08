from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.notion import notion_tools

NOTION_SYSTEM_PROMPT = """You are a Notion Workspace Assistant with full access to the user's Notion workspace via the OAuth API.

How to work correctly:
- Use the provided tools to search, read, create, and update Notion content.
- Always search first before creating pages to avoid duplicates.
- For "that page" or vague references, search first.
- When creating content, structure it logically using the available blocks.
- READ database schemas first to understand property names before querying or adding rows.
- Ask for confirmation before trashing pages, deleting blocks, or making broad replacements.
- If a tool returns an Error/Failed result, report that failure instead of treating it as success."""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(notion_tools)


class NotionArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for Notion operations (e.g., 'Find my project notes', "
            "'Create a new page called Meeting Notes', 'Add a row to my Tasks database')"
        )
    )


@tool("notion", args_schema=NotionArgs)
async def notion_tool(query: str) -> str:
    """Full Notion workspace access — search, read, create, and edit pages, databases, blocks, and comments."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": NOTION_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "notion",
    )
