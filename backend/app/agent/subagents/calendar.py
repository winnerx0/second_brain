from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.calendar import calendar_tools

CALENDAR_SYSTEM_PROMPT = """You are a Calendar Assistant with access to the user's Google Calendar.

You can:
- Fetch upcoming or past events for any date range
- Create timed events and all-day events
- Edit and delete existing events

When helping:
- Always use get_calendar_events to check existing events before creating or editing
- Use the user's configured timezone unless the user explicitly specifies another timezone
- Dates and times passed to tools must be ISO 8601 strings with timezone offsets for timed events, YYYY-MM-DD for all-day
- For destructive operations (delete, edit), first identify the exact event; ask for confirmation before editing or deleting
- If a tool returns an Error/Failed result, report that failure instead of treating it as success
- Return concise summaries of what was done or what was found"""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(calendar_tools)


class CalendarArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for calendar operations (e.g., 'What do I have "
            "tomorrow?', 'Schedule a meeting on Friday at 3pm', 'Delete my dentist appointment')"
        )
    )


@tool("calendar", args_schema=CalendarArgs)
async def calendar_tool(query: str) -> str:
    """Fetch, create, edit, or delete Google Calendar events."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": CALENDAR_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "calendar",
    )
