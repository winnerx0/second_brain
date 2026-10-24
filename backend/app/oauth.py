"""Outbound OAuth 2.0 for third-party connections — port of `src/oauth.ts`.

This is the app acting as an OAuth *client* against nine providers; it is not user
authentication. The service has none — it is single-user and assumed to sit behind a
private proxy.

Pending authorization states are held in memory with a ten-minute TTL, exactly as in
the TypeScript. That makes the OAuth flow single-process: a callback arriving at a
different worker would not find its state. The server therefore runs with one worker;
moving this to a table is the prerequisite for scaling out.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import secrets
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select, update

from app.config import get_settings
from app.db.engine import session_scope
from app.db.models import Connection
from app.http import get_client
from app.logging import get_logger

logger = get_logger("oauth")

STATE_TTL = dt.timedelta(minutes=10)
#: Refresh when the access token has less than this left, per `getValidToken`.
REFRESH_WINDOW = dt.timedelta(seconds=60)


@dataclass(frozen=True)
class OAuthConfig:
    auth_url: str
    token_url: str
    scopes: tuple[str, ...]
    client_id_env: str
    client_secret_env: str
    extra: dict[str, str] = field(default_factory=dict)
    #: Notion wants HTTP Basic credentials instead of form fields.
    basic_auth: bool = False
    #: Twitter/X requires PKCE.
    pkce: bool = False


_GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
_GOOGLE_OFFLINE = {"access_type": "offline", "prompt": "consent"}

OAUTH_CONFIGS: dict[str, OAuthConfig] = {
    "github": OAuthConfig(
        auth_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=("repo", "user"),
        client_id_env="GITHUB_OAUTH_CLIENT_ID",
        client_secret_env="GITHUB_OAUTH_CLIENT_SECRET",
    ),
    "gmail": OAuthConfig(
        auth_url=_GOOGLE_AUTH,
        token_url=_GOOGLE_TOKEN,
        scopes=("https://www.googleapis.com/auth/gmail.modify",),
        client_id_env="GOOGLE_OAUTH_CLIENT_ID",
        client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
        extra=dict(_GOOGLE_OFFLINE),
    ),
    "google_calendar": OAuthConfig(
        auth_url=_GOOGLE_AUTH,
        token_url=_GOOGLE_TOKEN,
        scopes=("https://www.googleapis.com/auth/calendar",),
        client_id_env="GOOGLE_OAUTH_CLIENT_ID",
        client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
        extra=dict(_GOOGLE_OFFLINE),
    ),
    "google_docs": OAuthConfig(
        auth_url=_GOOGLE_AUTH,
        token_url=_GOOGLE_TOKEN,
        scopes=(
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/drive",
        ),
        client_id_env="GOOGLE_OAUTH_CLIENT_ID",
        client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
        extra=dict(_GOOGLE_OFFLINE),
    ),
    "notion": OAuthConfig(
        auth_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        scopes=(),
        client_id_env="NOTION_OAUTH_CLIENT_ID",
        client_secret_env="NOTION_OAUTH_CLIENT_SECRET",
        basic_auth=True,
    ),
    "spotify": OAuthConfig(
        auth_url="https://accounts.spotify.com/authorize",
        token_url="https://accounts.spotify.com/api/token",
        scopes=(
            "user-read-playback-state",
            "user-modify-playback-state",
            "playlist-read-private",
            "user-library-read",
            "user-read-recently-played",
        ),
        client_id_env="SPOTIFY_OAUTH_CLIENT_ID",
        client_secret_env="SPOTIFY_OAUTH_CLIENT_SECRET",
    ),
    "twitter": OAuthConfig(
        auth_url="https://twitter.com/i/oauth2/authorize",
        token_url="https://api.twitter.com/2/oauth2/token",
        scopes=("tweet.read", "tweet.write", "users.read", "offline.access"),
        client_id_env="TWITTER_OAUTH_CLIENT_ID",
        client_secret_env="TWITTER_OAUTH_CLIENT_SECRET",
        pkce=True,
    ),
    "anilist": OAuthConfig(
        auth_url="https://anilist.co/api/v2/oauth/authorize",
        token_url="https://anilist.co/api/v2/oauth/token",
        scopes=(),
        client_id_env="ANILIST_OAUTH_CLIENT_ID",
        client_secret_env="ANILIST_OAUTH_CLIENT_SECRET",
    ),
    "todoist": OAuthConfig(
        auth_url="https://todoist.com/oauth/authorize",
        token_url="https://todoist.com/oauth/access_token",
        scopes=("data:read_write",),
        client_id_env="TODOIST_OAUTH_CLIENT_ID",
        client_secret_env="TODOIST_OAUTH_CLIENT_SECRET",
    ),
}


@dataclass
class _StateEntry:
    connection_name: str
    expires_at: dt.datetime
    code_verifier: str | None = None


_pending_states: dict[str, _StateEntry] = {}


def prune_states(now: dt.datetime | None = None) -> int:
    """Drop expired authorization states. Driven by the lifespan sweeper."""
    moment = now or dt.datetime.now(dt.UTC)
    expired = [key for key, entry in _pending_states.items() if entry.expires_at < moment]
    for key in expired:
        del _pending_states[key]
    return len(expired)


def _credentials(cfg: OAuthConfig) -> tuple[str, str]:
    settings = get_settings()
    return (
        settings.oauth_credential(cfg.client_id_env) or "",
        settings.oauth_credential(cfg.client_secret_env) or "",
    )


def _b64url(raw: bytes) -> str:
    """`base64url` with padding stripped, matching Node's `'base64url'` encoding."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def build_auth_url(connection_name: str) -> dict[str, str]:
    """Return `{"url": ...}` or `{"error": ...}`, as `buildAuthUrl` did."""
    cfg = OAUTH_CONFIGS.get(connection_name)
    if cfg is None:
        return {"error": f'No OAuth config for "{connection_name}"'}

    client_id, _ = _credentials(cfg)
    if not client_id:
        return {"error": f"{cfg.client_id_env} is not configured"}

    settings = get_settings()
    state = secrets.token_hex(16)
    entry = _StateEntry(
        connection_name=connection_name,
        expires_at=dt.datetime.now(dt.UTC) + STATE_TTL,
    )

    params: dict[str, str] = {
        "client_id": client_id,
        "redirect_uri": settings.redirect_uri,
        "response_type": "code",
        "state": state,
    }
    if cfg.scopes:
        params["scope"] = " ".join(cfg.scopes)
    params.update(cfg.extra)

    if cfg.pkce:
        verifier = _b64url(secrets.token_bytes(32))
        challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
        entry.code_verifier = verifier

    _pending_states[state] = entry
    query = httpx_urlencode(params)
    return {"url": f"{cfg.auth_url}?{query}"}


def httpx_urlencode(params: dict[str, str]) -> str:
    """`URLSearchParams.toString()` — space becomes `+`, not `%20`."""
    from urllib.parse import urlencode

    return urlencode(params)


def _token_request(cfg: OAuthConfig, body: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    client_id, client_secret = _credentials(cfg)
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }
    if cfg.basic_auth:
        token = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    else:
        body["client_id"] = client_id
        body["client_secret"] = client_secret
    return headers, body


def _expiry(data: dict[str, Any]) -> dt.datetime | None:
    """`connections.token_expiry` is a naive column; store naive UTC."""
    expires_in = data.get("expires_in")
    if not isinstance(expires_in, (int, float)):
        return None
    moment = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=float(expires_in))
    return moment.replace(tzinfo=None)


def _utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


async def handle_callback(code: str, state: str) -> dict[str, str]:
    """Exchange the authorization code and persist the tokens."""
    entry = _pending_states.get(state)
    if entry is None:
        return {"error": "Invalid or expired OAuth state"}
    if entry.expires_at < dt.datetime.now(dt.UTC):
        del _pending_states[state]
        return {"error": "OAuth state expired — please try again"}
    del _pending_states[state]

    cfg = OAUTH_CONFIGS.get(entry.connection_name)
    if cfg is None:
        return {"error": f'No config for "{entry.connection_name}"'}

    settings = get_settings()
    body = {
        "code": code,
        "redirect_uri": settings.redirect_uri,
        "grant_type": "authorization_code",
    }
    if entry.code_verifier:
        body["code_verifier"] = entry.code_verifier
    headers, body = _token_request(cfg, body)

    try:
        response = await get_client().post(cfg.token_url, headers=headers, data=body)
        data = response.json()
        if not isinstance(data, dict):
            data = {}
        if response.is_error or data.get("error"):
            logger.error("[oauth] token exchange failed for %s: %s", entry.connection_name, data)
            return {
                "error": str(
                    data.get("error_description") or data.get("error") or "Token exchange failed"
                )
            }

        refresh_token = data.get("refresh_token")
        async with session_scope() as session:
            await session.execute(
                update(Connection)
                .where(Connection.name == entry.connection_name)
                .values(
                    access_token=str(data.get("access_token") or ""),
                    refresh_token=refresh_token if isinstance(refresh_token, str) else None,
                    token_expiry=_expiry(data),
                    oauth_connected=True,
                    enabled=True,
                    updated_at=_utcnow_naive(),
                )
            )
        logger.info("[oauth] %s connected", entry.connection_name)
        return {"connectionName": entry.connection_name}
    except Exception as exc:
        logger.error("[oauth] callback error for %s", entry.connection_name, exc_info=exc)
        return {"error": str(exc)}


async def get_valid_token(connection_name: str) -> str | None:
    """The stored access token, refreshed if it expires within a minute.

    On refresh failure the stale token is returned rather than `None`, matching the
    TypeScript: a provider hiccup should not look like a disconnected integration.
    """
    async with session_scope() as session:
        row = (
            await session.execute(
                select(
                    Connection.access_token,
                    Connection.refresh_token,
                    Connection.token_expiry,
                ).where(Connection.name == connection_name)
            )
        ).first()

    if row is None or not row.access_token:
        return None

    expiry = row.token_expiry
    needs_refresh = bool(
        row.refresh_token and expiry is not None and expiry - _utcnow_naive() < REFRESH_WINDOW
    )
    if not needs_refresh:
        return row.access_token

    cfg = OAUTH_CONFIGS.get(connection_name)
    if cfg is None:
        return row.access_token

    headers, body = _token_request(
        cfg, {"grant_type": "refresh_token", "refresh_token": row.refresh_token or ""}
    )
    try:
        response = await get_client().post(cfg.token_url, headers=headers, data=body)
        data = response.json()
        if not isinstance(data, dict):
            data = {}
        if response.is_error or data.get("error"):
            logger.error("[oauth] token refresh failed for %s: %s", connection_name, data)
            return row.access_token

        access_token = str(data.get("access_token") or "")
        new_refresh = data.get("refresh_token")
        async with session_scope() as session:
            await session.execute(
                update(Connection)
                .where(Connection.name == connection_name)
                .values(
                    access_token=access_token,
                    refresh_token=(
                        new_refresh if isinstance(new_refresh, str) else row.refresh_token
                    ),
                    token_expiry=_expiry(data),
                    updated_at=_utcnow_naive(),
                )
            )
        logger.info("[oauth] %s token refreshed", connection_name)
        return access_token
    except Exception as exc:
        logger.error("[oauth] refresh error for %s", connection_name, exc_info=exc)
        return row.access_token


async def get_db_refresh_token(connection_name: str) -> str | None:
    async with session_scope() as session:
        return (
            await session.execute(
                select(Connection.refresh_token).where(Connection.name == connection_name)
            )
        ).scalar_one_or_none()


async def disconnect_oauth(connection_name: str) -> None:
    async with session_scope() as session:
        await session.execute(
            update(Connection)
            .where(Connection.name == connection_name)
            .values(
                access_token=None,
                refresh_token=None,
                token_expiry=None,
                oauth_connected=False,
                updated_at=_utcnow_naive(),
            )
        )
    logger.info("[oauth] %s disconnected", connection_name)
