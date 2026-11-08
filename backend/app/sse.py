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

#: The charset is part of the header clients receive; keep it byte-identical.
SSE_MEDIA_TYPE = "text/event-stream; charset=utf-8"


def frame(data: str, *, event: str | None = None, event_id: str | None = None) -> bytes:
    parts = ""
    if event_id is not None:
        parts += f"id: {event_id}\n"
    if event is not None:
        parts += f"event: {event}\n"
    return (parts + f"data: {data}\n\n").encode("utf-8")


def event_frame(payload: dict[str, object]) -> bytes:
    name = payload.get("type")
    return frame(dumps(payload), event=str(name) if name is not None else None)
