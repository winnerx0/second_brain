from __future__ import annotations

import httpx

_client: httpx.AsyncClient | None = None

TIMEOUT = httpx.Timeout(30.0, connect=10.0)
LIMITS = httpx.Limits(max_keepalive_connections=20, max_connections=100)


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=TIMEOUT, limits=LIMITS, follow_redirects=True)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
