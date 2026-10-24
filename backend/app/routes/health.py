"""`GET /health` — `src/app.ts:178`."""

from __future__ import annotations

from fastapi import APIRouter, Response

from app.json import JsonResponse, now_ms

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> Response:
    # `timestamp` is `Date.now()`: integer milliseconds, not seconds.
    return JsonResponse({"status": "ok", "timestamp": now_ms()})
