"""JSON encoding that matches what the Hono backend put on the wire.

`web/` parses timestamps with `new Date(...)`, and the TypeScript backend produced
them via `JSON.stringify(jsValue)` on a `Date` that node-postgres had built. That
always yields exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` — three fractional digits, always
a `Z` suffix.

Python's defaults differ in two ways that both change behaviour in the browser:

* `datetime.isoformat()` emits microseconds (six digits) and `+00:00` rather than `Z`
  for aware values;
* for a *naive* value it emits no offset at all, and `new Date("2026-10-24T12:34:56")`
  is parsed by browsers as **local time** — so every naive-timestamp column would
  appear shifted by the viewer's UTC offset, silently.

The schema mixes naive and aware columns (`workflow_runs.ran_at` is naive while
`scheduled_for` in the same row is aware), so this has to be handled centrally.
Aware values are converted to UTC; naive values are already UTC by construction
(the connection runs with `timezone=UTC`) and are labelled as such.

`separators=(",", ":")` matches `JSON.stringify`'s whitespace-free output, which also
matters for the SSE `data:` payloads.
"""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from typing import Any

from fastapi.responses import JSONResponse


def js_date(value: dt.datetime) -> str:
    """Render a datetime the way `JSON.stringify(new Date(...))` does."""
    if value.tzinfo is not None:
        value = value.astimezone(dt.UTC).replace(tzinfo=None)
    return value.isoformat(timespec="milliseconds") + "Z"


def default(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return js_date(value)
    if isinstance(value, dt.date):
        # Drizzle's `date` columns (task_history.first_seen/completed_at) come back
        # as plain 'YYYY-MM-DD' strings, not Dates.
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (set, frozenset)):
        return list(value)
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def dumps(value: Any) -> str:
    return json.dumps(value, default=default, separators=(",", ":"), ensure_ascii=False)


class JsonResponse(JSONResponse):
    """The response class every route returns explicitly.

    Setting this as FastAPI's `default_response_class` is *not* sufficient: when a
    route returns a plain dict, FastAPI runs its own `jsonable_encoder` over the value
    first, which renders datetimes with microseconds and no `Z` — so the encoder below
    never sees a datetime and the output silently stops matching the TypeScript
    service. Returning a `Response` instance short-circuits that encoding, so routes
    build a plain dict and wrap it here on the way out.
    """

    def render(self, content: Any) -> bytes:
        return dumps(content).encode("utf-8")


def now_ms() -> int:
    """`Date.now()` — integer milliseconds since the epoch."""
    return int(dt.datetime.now(dt.UTC).timestamp() * 1000)
