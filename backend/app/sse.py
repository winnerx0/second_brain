"""Server-sent event framing.

Written by hand rather than using `sse-starlette`, because the two SSE endpoints
speak different dialects and both are consumed by code in `web/`:

* `/chat/stream` sends `event: <type>` / `data: <json>` frames and a **comment**
  heartbeat (`: heartbeat`), which `formatSseEvent` in `src/app.ts` produced;
* `/workflows/runs/{id}/events` sends `id:` / `data:` frames plus a **named**
  `heartbeat` event and a terminal `done` event, which Hono's `streamSSE` produced.

`sse-starlette`'s keep-alive is always a comment, so it is right for the first and
wrong for the second. Fifteen lines here avoids configuring around that.
"""

from __future__ import annotations

from app.json import dumps

#: `: heartbeat\n\n` — a comment frame, ignored by EventSource but enough to keep
#: proxies and load balancers from closing an idle stream.
COMMENT_HEARTBEAT = b": heartbeat\n\n"

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Stops nginx/Caddy buffering the whole stream, which would make chat appear to
    # hang until the response completed.
    "X-Accel-Buffering": "no",
}

#: The charset is part of the header the TypeScript sent; keep it byte-identical.
SSE_MEDIA_TYPE = "text/event-stream; charset=utf-8"


def frame(data: str, *, event: str | None = None, event_id: str | None = None) -> bytes:
    """Build one SSE frame. Field order matches what the TypeScript emitted."""
    parts = ""
    if event_id is not None:
        parts += f"id: {event_id}\n"
    if event is not None:
        parts += f"event: {event}\n"
    return (parts + f"data: {data}\n\n").encode("utf-8")


def event_frame(payload: dict[str, object]) -> bytes:
    """`formatSseEvent` — the frame shape `/chat/stream` uses.

    The event name is the payload's own `type`, and the payload is repeated in full
    inside `data`, exactly as `src/app.ts` did.
    """
    name = payload.get("type")
    return frame(dumps(payload), event=str(name) if name is not None else None)
