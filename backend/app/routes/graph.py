"""Knowledge-graph read endpoint — `src/app.ts:883-937`.

`POST /graph/maintenance` is deliberately absent until `app/memory/heal.py` is ported;
it runs dedupe, LLM contradiction resolution, edge repair and re-embedding.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response
from sqlalchemy import select

from app.db.engine import session_scope
from app.db.models import GraphEdge, GraphNode
from app.json import JsonResponse
from app.logging import get_logger

router = APIRouter(tags=["graph"])
logger = get_logger("graph")


@router.get("/graph")
async def get_graph(kind: str | None = None, status: str = "active") -> Response:
    """Nodes plus the edges whose endpoints are both in the returned node set.

    `status=all` disables the status filter. The edge filtering happens in Python
    rather than SQL, matching `src/app.ts` — it loads every edge and keeps those whose
    endpoints survived the node filter.
    """
    try:
        async with session_scope() as session:
            conditions: list[Any] = []
            if status != "all":
                conditions.append(GraphNode.status == status)
            if kind:
                conditions.append(GraphNode.kind == kind)

            node_rows = (
                await session.execute(
                    select(
                        GraphNode.id,
                        GraphNode.kind,
                        GraphNode.name,
                        GraphNode.key,
                        GraphNode.value,
                        GraphNode.classification,
                        GraphNode.tier,
                        GraphNode.importance,
                        GraphNode.status,
                        GraphNode.recall_count,
                        GraphNode.source,
                        GraphNode.confidence,
                    ).where(*conditions)
                )
            ).all()

            edge_rows = (
                await session.execute(
                    select(
                        GraphEdge.id,
                        GraphEdge.from_node_id,
                        GraphEdge.to_node_id,
                        GraphEdge.relation,
                        GraphEdge.weight,
                        GraphEdge.confidence,
                        GraphEdge.created_by,
                    )
                )
            ).all()

        node_ids = {row.id for row in node_rows}
        return JsonResponse(
            {
                "nodes": [
                    {
                        "id": row.id,
                        "kind": row.kind,
                        "name": row.name,
                        "key": row.key,
                        "value": row.value,
                        "classification": row.classification,
                        "tier": row.tier,
                        "importance": row.importance,
                        "status": row.status,
                        "recallCount": row.recall_count,
                        "source": row.source,
                        "confidence": row.confidence,
                    }
                    for row in node_rows
                ],
                "edges": [
                    {
                        "id": row.id,
                        "fromNodeId": row.from_node_id,
                        "toNodeId": row.to_node_id,
                        "relation": row.relation,
                        "weight": row.weight,
                        "confidence": row.confidence,
                        "createdBy": row.created_by,
                    }
                    for row in edge_rows
                    if row.from_node_id in node_ids and row.to_node_id in node_ids
                ],
            }
        )
    except Exception as exc:
        logger.error("[graph] %s", exc, exc_info=exc)
        return JsonResponse({"error": str(exc) or "Failed to load graph"}, status_code=500)
