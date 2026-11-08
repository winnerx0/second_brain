from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from typing import Any

from fastapi.responses import JSONResponse


def js_date(value: dt.datetime) -> str:
    """Render a datetime the way JavaScript's `Date.toISOString` does (millisecond precision, `Z`)."""
    if value.tzinfo is not None:
        value = value.astimezone(dt.UTC).replace(tzinfo=None)
    return value.isoformat(timespec="milliseconds") + "Z"


def default(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return js_date(value)
    if isinstance(value, dt.date):
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
    never sees a datetime and the output silently stops matching the format clients expect. Returning a `Response` instance short-circuits that encoding, so routes
    build a plain dict and wrap it here on the way out.
    """

    def render(self, content: Any) -> bytes:
        return dumps(content).encode("utf-8")


def now_ms() -> int:
    """`Date.now()` — integer milliseconds since the epoch."""
    return int(dt.datetime.now(dt.UTC).timestamp() * 1000)
