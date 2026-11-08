from __future__ import annotations

from app.http import get_client
from app.oauth import OAUTH_CONFIGS, _token_request, get_db_refresh_token, get_valid_token


async def google_access_token(connection_name: str, static_refresh_token: str | None) -> str:
    """A bearer access token for a Google-backed connection (gmail, google_calendar, google_docs).

    Fallback chain: a
    cached, auto-refreshed DB access token; failing that, a refresh token — from the DB
    connection or from static settings — exchanged for an access token on the spot.
    """
    token = await get_valid_token(connection_name)
    if token:
        return token

    refresh_token = await get_db_refresh_token(connection_name) or static_refresh_token
    if not refresh_token:
        raise RuntimeError(
            f"{connection_name} not connected. Go to Connections to authorize, or "
            "configure a refresh token."
        )

    cfg = OAUTH_CONFIGS[connection_name]
    headers, body = _token_request(
        cfg, {"grant_type": "refresh_token", "refresh_token": refresh_token}
    )
    response = await get_client().post(cfg.token_url, headers=headers, data=body)
    data = response.json()
    if response.is_error or not isinstance(data, dict) or not data.get("access_token"):
        raise RuntimeError(f"Failed to refresh {connection_name} token: {data}")
    return str(data["access_token"])
