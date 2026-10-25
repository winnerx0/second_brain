"""Miscellaneous tools — port of `src/tools/miscellaneous.ts`."""

from __future__ import annotations

import datetime as dt

from langchain_core.tools import tool

from app.json import js_date


@tool("get_current_datetime")
async def get_current_datetime() -> str:
    """Returns the current date and time in ISO 8601 format. Call this whenever you need to know the current time, date, day of the week, or relative time."""
    # `new Date().toISOString()` — millisecond precision with a `Z` suffix.
    return js_date(dt.datetime.now(dt.UTC))


misc_tools = [get_current_datetime]
