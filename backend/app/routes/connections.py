"""Connection management — `src/app.ts:421-666`."""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import select, update

from app.connections import API_KEY_CONNECTIONS, REMOVED_CONNECTIONS
from app.db.engine import session_scope
from app.db.models import Connection
from app.errors import BadRequestError
from app.json import JsonResponse
from app.logging import get_logger
from app.oauth import OAUTH_CONFIGS, build_auth_url, disconnect_oauth

router = APIRouter(tags=["connections"])
logger = get_logger("connections")


def _utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def _connection_id(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError:
        raise BadRequestError("Invalid id") from None
    if value <= 0:
        raise BadRequestError("Invalid id")
    return value


@router.get("/connections")
async def list_connections() -> Response:
    """Connections with their derived capability flags.

    `accessToken` is read to compute `apiKeyConnected` but never returned.
    """
    from app.config import get_settings

    settings = get_settings()
    try:
        async with session_scope() as session:
            rows = (
                await session.execute(
                    select(
                        Connection.id,
                        Connection.name,
                        Connection.label,
                        Connection.enabled,
                        Connection.oauth_connected,
                        Connection.access_token,
                        Connection.created_at,
                        Connection.updated_at,
                    ).order_by(Connection.id.asc())
                )
            ).all()

        payload: list[dict[str, Any]] = []
        for row in rows:
            if row.name in REMOVED_CONNECTIONS:
                continue
            cfg = OAUTH_CONFIGS.get(row.name)
            payload.append(
                {
                    "id": row.id,
                    "name": row.name,
                    "label": row.label,
                    "enabled": row.enabled,
                    "oauthConnected": row.oauth_connected,
                    "createdAt": row.created_at,
                    "updatedAt": row.updated_at,
                    "oauthSupported": row.name in OAUTH_CONFIGS,
                    "oauthConfigured": bool(cfg and settings.oauth_credential(cfg.client_id_env)),
                    "apiKeySupported": row.name in API_KEY_CONNECTIONS,
                    "apiKeyConnected": row.name in API_KEY_CONNECTIONS and bool(row.access_token),
                }
            )
        return JsonResponse({"connections": payload})
    except Exception as exc:
        logger.error("[connections.list] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to list connections"}, status_code=500)


@router.post("/connections", status_code=201)
async def create_connection(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body if isinstance(body, dict) else {}
    name = raw.get("name") if isinstance(raw.get("name"), str) else ""
    label = raw.get("label") if isinstance(raw.get("label"), str) else ""
    if not name or not label:
        return JsonResponse({"error": "name and label are required"}, status_code=400)
    if name.lower() in REMOVED_CONNECTIONS:
        return JsonResponse({"error": f'"{name}" is no longer supported'}, status_code=400)

    try:
        async with session_scope() as session:
            created = Connection(name=name.lower(), label=label)
            session.add(created)
            await session.flush()
            payload = {
                "id": created.id,
                "name": created.name,
                "label": created.label,
                "enabled": created.enabled,
                "oauthConnected": created.oauth_connected,
                "accessToken": created.access_token,
                "refreshToken": created.refresh_token,
                "tokenExpiry": created.token_expiry,
                "createdAt": created.created_at,
                "updatedAt": created.updated_at,
            }
        return JsonResponse({"connection": payload}, status_code=201)
    except Exception as exc:
        logger.error("[connections.create] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to create connection"}, status_code=500)


@router.patch("/connections/{connection_id}")
async def update_connection(connection_id: str, request: Request) -> Response:
    value_id = _connection_id(connection_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    enabled = body.get("enabled") if isinstance(body, dict) else None
    if not isinstance(enabled, bool):
        return JsonResponse({"error": "enabled must be a boolean"}, status_code=400)

    try:
        async with session_scope() as session:
            updated = (
                await session.execute(
                    update(Connection)
                    .where(Connection.id == value_id)
                    .values(enabled=enabled, updated_at=_utcnow_naive())
                    .returning(Connection)
                )
            ).scalar_one_or_none()
            if updated is None:
                return JsonResponse({"error": "Connection not found"}, status_code=404)
            payload = {
                "id": updated.id,
                "name": updated.name,
                "label": updated.label,
                "enabled": updated.enabled,
                "oauthConnected": updated.oauth_connected,
                "accessToken": updated.access_token,
                "refreshToken": updated.refresh_token,
                "tokenExpiry": updated.token_expiry,
                "createdAt": updated.created_at,
                "updatedAt": updated.updated_at,
            }
        return JsonResponse({"connection": payload})
    except Exception as exc:
        logger.error("[connections.patch] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to update connection"}, status_code=500)


@router.put("/connections/{name}/apikey")
async def put_api_key(name: str, request: Request) -> Response:
    if name not in API_KEY_CONNECTIONS:
        return JsonResponse({"error": f"{name} does not use API key auth"}, status_code=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body.get("apiKey") if isinstance(body, dict) else None
    api_key = raw.strip() if isinstance(raw, str) else ""
    if not api_key:
        return JsonResponse({"error": "apiKey is required"}, status_code=400)

    try:
        async with session_scope() as session:
            await session.execute(
                update(Connection)
                .where(Connection.name == name)
                .values(
                    access_token=api_key,
                    oauth_connected=True,
                    enabled=True,
                    updated_at=_utcnow_naive(),
                )
            )
        logger.info("[connections] %s api key saved", name)
        return JsonResponse({"ok": True})
    except Exception as exc:
        logger.error("[connections.apikey.put] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to save API key"}, status_code=500)


@router.delete("/connections/{name}/apikey")
async def delete_api_key(name: str) -> Response:
    if name not in API_KEY_CONNECTIONS:
        return JsonResponse({"error": f"{name} does not use API key auth"}, status_code=400)
    try:
        async with session_scope() as session:
            await session.execute(
                update(Connection)
                .where(Connection.name == name)
                .values(access_token=None, oauth_connected=False, updated_at=_utcnow_naive())
            )
        logger.info("[connections] %s api key removed", name)
        return JsonResponse({"ok": True})
    except Exception as exc:
        logger.error("[connections.apikey.delete] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to remove API key"}, status_code=500)


@router.get("/connections/{name}/oauth/start")
async def oauth_start(name: str) -> Response:
    """Redirect straight to the provider.

    `web/` links to this with a plain anchor, so it must be a 302 the browser
    follows. `RedirectResponse` defaults to 307, which preserves the method and
    breaks the flow — hence the explicit status.
    """
    result = build_auth_url(name)
    if "error" in result:
        return JsonResponse({"error": result["error"]}, status_code=400)
    return RedirectResponse(result["url"], status_code=302)


@router.delete("/connections/{name}/oauth")
async def oauth_disconnect(name: str) -> Response:
    try:
        await disconnect_oauth(name)
        return JsonResponse({"success": True})
    except Exception as exc:
        logger.error("[connections.oauth.disconnect] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to disconnect"}, status_code=500)
