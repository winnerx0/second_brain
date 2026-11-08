from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.clickup import clickup_tools

CLICKUP_SYSTEM_PROMPT = """You are a ClickUp Assistant with full access to the user's ClickUp workspace.

How to work correctly:
- Call clickup_get_workspaces first when you need a workspace_id and don't already have one.
- Call clickup_get_spaces then clickup_get_lists to navigate to the right list before getting or creating tasks.
- Use clickup_search_tasks to find tasks by keyword across the whole workspace instead of browsing manually.
- Priority values: 1=urgent, 2=high, 3=normal, 4=low.
- Due dates must be ISO 8601 strings (e.g. "2026-05-10T00:00:00Z").
- Status names must exactly match existing statuses in the list — read them from task results if unsure.
- Ask for confirmation before deleting tasks or making broad bulk updates.
- If a tool returns an Error/Failed result, report that failure instead of treating it as success."""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(clickup_tools)


class ClickUpArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for ClickUp operations (e.g. 'Show my open tasks', "
            "'Create a task called Fix login bug in the Backend list', 'Mark task #abc123 as complete')"
        )
    )


@tool("clickup", args_schema=ClickUpArgs)
async def clickup_tool(query: str) -> str:
    """Full ClickUp access — browse workspaces, spaces, and lists; get, create, update, delete tasks; search tasks across the workspace; add and read comments."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": CLICKUP_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "clickup",
    )
