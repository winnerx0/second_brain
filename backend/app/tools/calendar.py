from __future__ import annotations

import datetime as dt
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.tools.google_auth import google_access_token

logger = get_logger("calendar")

CALENDAR_API = "https://www.googleapis.com/calendar/v3"

#: An edited/deleted event's current start must match a found event within this window.
EVENT_MATCH_TOLERANCE = dt.timedelta(minutes=10)


async def _headers() -> dict[str, str]:
    token = await google_access_token("google_calendar", None)
    return {"Authorization": f"Bearer {token}"}


def _local_date_today() -> str:
    return dt.datetime.now(get_settings().tz).date().isoformat()


def _zoned_to_utc(date: str, time: str) -> dt.datetime:
    naive = dt.datetime.fromisoformat(f"{date}T{time}")
    return naive.replace(tzinfo=get_settings().tz).astimezone(dt.UTC)


def _date_range_to_utc_bounds(start_date: str | None, end_date: str | None) -> tuple[dt.datetime, dt.datetime]:
    start = start_date or _local_date_today()
    end = end_date or start
    return _zoned_to_utc(start, "00:00:00"), _zoned_to_utc(end, "23:59:59")


def _add_days(date: str, days: int) -> str:
    return (dt.date.fromisoformat(date) + dt.timedelta(days=days)).isoformat()


def _summarize_event(event: dict[str, Any]) -> dict[str, Any]:
    start = event.get("start") or {}
    end = event.get("end") or {}
    return {
        "summary": event.get("summary") or "Untitled",
        "start": start.get("dateTime") or start.get("date") or "",
        "end": end.get("dateTime") or end.get("date") or "",
        "attendees": [
            attendee.get("displayName") or attendee.get("email") or "Unknown"
            for attendee in event.get("attendees") or []
        ],
    }


async def _list_events(time_min: dt.datetime, time_max: dt.datetime) -> list[dict[str, Any]]:
    response = await get_client().get(
        f"{CALENDAR_API}/calendars/{get_settings().GOOGLE_CALENDAR_ID}/events",
        params={
            "timeMin": time_min.isoformat().replace("+00:00", "Z"),
            "timeMax": time_max.isoformat().replace("+00:00", "Z"),
            "singleEvents": "true",
            "orderBy": "startTime",
        },
        headers=await _headers(),
    )
    response.raise_for_status()
    return response.json().get("items") or []


async def _find_event_by_start(start_date_time: str) -> dict[str, Any] | None:
    target = dt.datetime.fromisoformat(start_date_time.replace("Z", "+00:00"))
    if target.tzinfo is None:
        target = target.replace(tzinfo=dt.UTC)
    day_start = dt.datetime(target.year, target.month, target.day, tzinfo=dt.UTC)
    day_end = day_start + dt.timedelta(days=1)

    items = await _list_events(day_start, day_end)
    if not items:
        return None

    closest = items[0]
    closest_diff = dt.timedelta.max
    for item in items:
        start = (item.get("start") or {}).get("dateTime") or (item.get("start") or {}).get("date") or ""
        event_start = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
        if event_start.tzinfo is None:
            event_start = event_start.replace(tzinfo=dt.UTC)
        diff = abs(event_start - target)
        if diff < closest_diff:
            closest_diff = diff
            closest = item

    if closest_diff > EVENT_MATCH_TOLERANCE or not closest.get("id"):
        return None
    return {"id": closest["id"], "summary": closest.get("summary") or "Untitled"}


class GetCalendarEventsArgs(BaseModel):
    startDate: str | None = Field(
        default=None, description="Start date in YYYY-MM-DD format. Defaults to today."
    )
    endDate: str | None = Field(
        default=None, description="End date in YYYY-MM-DD format. Defaults to startDate if omitted."
    )


@tool("get_calendar_events", args_schema=GetCalendarEventsArgs)
async def get_calendar_events(startDate: str | None = None, endDate: str | None = None) -> str:
    """Get Google Calendar events. Defaults to today in the user's timezone when no dates are provided. Supply startDate and/or endDate (YYYY-MM-DD) to fetch events for any date range."""
    try:
        time_min, time_max = _date_range_to_utc_bounds(startDate, endDate)
        items = await _list_events(time_min, time_max)
        return dumps([_summarize_event(item) for item in items])
    except Exception as exc:
        logger.error("[calendar]", exc_info=exc)
        return f"Error fetching calendar events: {exc}"


class CreateCalendarEventArgs(BaseModel):
    summary: str = Field(description="Event title")
    start: str = Field(description="Start datetime in ISO 8601 format, preferably with timezone offset")
    end: str = Field(description="End datetime in ISO 8601 format, preferably with timezone offset")
    description: str | None = Field(default=None, description="Event description or notes")
    attendees: list[str] | None = Field(default=None, description="List of attendee email addresses")


@tool("create_calendar_event", args_schema=CreateCalendarEventArgs)
async def create_calendar_event(
    summary: str,
    start: str,
    end: str,
    description: str | None = None,
    attendees: list[str] | None = None,
) -> str:
    """Create a new event on Google Calendar. Start and end must be ISO 8601 datetime strings, preferably with timezone offsets. Attendees are optional email addresses."""
    try:
        settings = get_settings()
        logger.info(
            "[calendar] createCalendarEvent summary=%s start=%s end=%s description=%s attendees=%s",
            summary,
            start,
            end,
            description,
            attendees,
        )
        payload: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": start, "timeZone": settings.USER_TIMEZONE},
            "end": {"dateTime": end, "timeZone": settings.USER_TIMEZONE},
        }
        if description:
            payload["description"] = description
        if attendees:
            payload["attendees"] = [{"email": email} for email in attendees]

        response = await get_client().post(
            f"{CALENDAR_API}/calendars/{settings.GOOGLE_CALENDAR_ID}/events",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Error creating calendar event: {response.text}"
        event = response.json()
        event_start = (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date")
        return f'Event created: "{event.get("summary")}" on {event_start} — {event.get("htmlLink")}'
    except Exception as exc:
        logger.error("[calendar]", exc_info=exc)
        return f"Error creating calendar event: {exc}"


class CreateAllDayCalendarEventArgs(BaseModel):
    summary: str = Field(description="Event title")
    date: str = Field(description='Start date in YYYY-MM-DD format (e.g. "2026-04-03")')
    endDate: str | None = Field(
        default=None,
        description="End date in YYYY-MM-DD format, exclusive. Defaults to the same day as date.",
    )
    description: str | None = Field(default=None, description="Event description or notes")
    attendees: list[str] | None = Field(default=None, description="List of attendee email addresses")


@tool("create_all_day_calendar_event", args_schema=CreateAllDayCalendarEventArgs)
async def create_all_day_calendar_event(
    summary: str,
    date: str,
    endDate: str | None = None,
    description: str | None = None,
    attendees: list[str] | None = None,
) -> str:
    """Create an all-day Google Calendar event. Use date strings in YYYY-MM-DD format. For multi-day events supply endDate (exclusive — e.g. a 3-day event starting 2026-04-03 ends on 2026-04-06)."""
    try:
        settings = get_settings()
        payload: dict[str, Any] = {
            "summary": summary,
            "start": {"date": date},
            "end": {"date": endDate or _add_days(date, 1)},
        }
        if description:
            payload["description"] = description
        if attendees:
            payload["attendees"] = [{"email": email} for email in attendees]

        response = await get_client().post(
            f"{CALENDAR_API}/calendars/{settings.GOOGLE_CALENDAR_ID}/events",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Error creating all-day event: {response.text}"
        event = response.json()
        return f'All-day event created: "{event.get("summary")}" on {(event.get("start") or {}).get("date")} — {event.get("htmlLink")}'
    except Exception as exc:
        logger.error("[calendar]", exc_info=exc)
        return f"Error creating all-day event: {exc}"


class EditCalendarEventArgs(BaseModel):
    startDateTime: str = Field(description="Current start datetime of the event to edit as ISO 8601")
    summary: str = Field(description="New event title")
    newStart: str = Field(description="New start datetime as ISO 8601")
    newEnd: str = Field(description="New end datetime as ISO 8601")
    description: str | None = Field(default=None, description="New event description")
    attendees: list[str] | None = Field(default=None, description="New list of attendee emails")


@tool("edit_calendar_event", args_schema=EditCalendarEventArgs)
async def edit_calendar_event(
    startDateTime: str,
    summary: str,
    newStart: str,
    newEnd: str,
    description: str | None = None,
    attendees: list[str] | None = None,
) -> str:
    """Edit an existing Google Calendar event found by its current start datetime. The current start time must match an event within 10 minutes."""
    try:
        found = await _find_event_by_start(startDateTime)
        if found is None:
            return f"No event found starting at {startDateTime}"

        settings = get_settings()
        payload: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": newStart, "timeZone": settings.USER_TIMEZONE},
            "end": {"dateTime": newEnd, "timeZone": settings.USER_TIMEZONE},
        }
        if description:
            payload["description"] = description
        if attendees:
            payload["attendees"] = [{"email": email} for email in attendees]

        response = await get_client().put(
            f"{CALENDAR_API}/calendars/{settings.GOOGLE_CALENDAR_ID}/events/{found['id']}",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Error editing calendar event: {response.text}"
        event = response.json()
        event_start = (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date")
        return f'Event edited: "{event.get("summary")}" on {event_start} — {event.get("htmlLink")}'
    except Exception as exc:
        logger.error("[calendar]", exc_info=exc)
        return f"Error editing calendar event: {exc}"


class DeleteCalendarEventArgs(BaseModel):
    startDateTime: str = Field(description="Start datetime of the event to delete as ISO 8601")


@tool("delete_calendar_event", args_schema=DeleteCalendarEventArgs)
async def delete_calendar_event(startDateTime: str) -> str:
    """Delete a Google Calendar event found by its start datetime. The start time must match an event within 10 minutes."""
    try:
        logger.info("[calendar] deleteCalendarEvent startDateTime=%s", startDateTime)
        found = await _find_event_by_start(startDateTime)
        if found is None:
            return f"No event found starting at {startDateTime}"

        settings = get_settings()
        response = await get_client().delete(
            f"{CALENDAR_API}/calendars/{settings.GOOGLE_CALENDAR_ID}/events/{found['id']}",
            headers=await _headers(),
        )
        if response.is_error:
            return f"Error deleting calendar event: {response.text}"
        return f'Event "{found["summary"]}" deleted successfully'
    except Exception as exc:
        logger.error("[calendar]", exc_info=exc)
        return f"Error deleting calendar event: {exc}"


calendar_tools = [
    get_calendar_events,
    create_calendar_event,
    create_all_day_calendar_event,
    edit_calendar_event,
    delete_calendar_event,
]
