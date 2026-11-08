from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Request, Response
from sqlalchemy import delete, select, update

from app.db.engine import session_scope
from app.db.models import GraphNode
from app.errors import BadRequestError
from app.json import JsonResponse
from app.logging import get_logger

router = APIRouter(tags=["memories"])
logger = get_logger("memories")


def _memory_id(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError:
        raise BadRequestError("Invalid memory id") from None
    if value <= 0:
        raise BadRequestError("Invalid memory id")
    return value


def _full_node_json(row: GraphNode) -> dict[str, Any]:
    """Every column, camelCased.

    `PATCH /memories/:id` returns the unprojected row, so its
    response carries the whole row — including `vector` (1536 floats), `aliases`,
    `metadata` and `normalizedName`. Trimming it would be a frontend-visible change,
    so it is preserved; revisit separately after the migration if the payload size
    matters.
    """
    return {
        "id": row.id,
        "kind": row.kind,
        "name": row.name,
        "normalizedName": row.normalized_name,
        "aliases": list(row.aliases or []),
        "metadata": row.meta,
        "key": row.key,
        "value": row.value,
        "classification": row.classification,
        "tier": row.tier,
        "importance": row.importance,
        "vector": list(row.vector) if row.vector is not None else None,
        "recallCount": row.recall_count,
        "lastRecalledAt": row.last_recalled_at,
        "status": row.status,
        "source": row.source,
        "confidence": row.confidence,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


@router.get("/memories")
async def list_memories() -> Response:
    try:
        async with session_scope() as session:
            rows = (
                await session.execute(
                    select(
                        GraphNode.id,
                        GraphNode.key,
                        GraphNode.value,
                        GraphNode.classification,
                        GraphNode.tier,
                        GraphNode.importance,
                        GraphNode.created_at,
                        GraphNode.updated_at,
                    )
                    .where(GraphNode.kind == "memory", GraphNode.status == "active")
                    .order_by(GraphNode.updated_at.desc())
                )
            ).all()
            return JsonResponse(
                {
                    "memories": [
                        {
                            "id": row.id,
                            "key": row.key,
                            "value": row.value,
                            "classification": row.classification,
                            "tier": row.tier,
                            "importance": row.importance,
                            "createdAt": row.created_at,
                            "updatedAt": row.updated_at,
                        }
                        for row in rows
                    ]
                }
            )
    except Exception as exc:
        logger.error("[memories] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to fetch memories"}, status_code=500)


@router.patch("/memories/{memory_id}")
async def update_memory(memory_id: str, request: Request) -> Response:
    value_id = _memory_id(memory_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body.get("value") if isinstance(body, dict) else None
    new_value = raw.strip() if isinstance(raw, str) else ""
    if not new_value:
        return JsonResponse({"error": "value is required"}, status_code=400)

    try:
        async with session_scope() as session:
            updated = (
                await session.execute(
                    update(GraphNode)
                    .where(GraphNode.id == value_id, GraphNode.kind == "memory")
                    .values(
                        value=new_value, updated_at=dt.datetime.now(dt.UTC).replace(tzinfo=None)
                    )
                    .returning(GraphNode)
                )
            ).scalar_one_or_none()
            if updated is None:
                return JsonResponse({"error": "Memory not found"}, status_code=404)
            return JsonResponse({"memory": _full_node_json(updated)})
    except Exception as exc:
        logger.error("[memories.patch] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to update memory"}, status_code=500)


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str) -> Response:
    value_id = _memory_id(memory_id)
    try:
        async with session_scope() as session:
            deleted = (
                await session.execute(
                    delete(GraphNode)
                    .where(GraphNode.id == value_id, GraphNode.kind == "memory")
                    .returning(GraphNode.id)
                )
            ).all()
            if not deleted:
                return JsonResponse({"error": "Memory not found"}, status_code=404)
            return JsonResponse({"success": True})
    except Exception as exc:
        logger.error("[memories.delete] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to delete memory"}, status_code=500)
