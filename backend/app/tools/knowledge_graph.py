from __future__ import annotations

import datetime as dt
import json
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field
from sqlalchemy import any_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GraphEdge, GraphNode
from app.json import dumps
from app.logging import get_logger

logger = get_logger("knowledge-graph")

NodeKind = Literal["person", "project", "document", "task", "decision", "topic", "other"]

NODE_KIND_VALUES: tuple[str, ...] = (
    "person",
    "project",
    "document",
    "task",
    "decision",
    "topic",
    "other",
)


def normalize_name(value: str) -> str:
    """Trim, lower-case and collapse internal whitespace."""
    return " ".join(value.strip().lower().split())


def _utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def _clean_aliases(aliases: list[str] | None) -> list[str]:
    return [alias.strip() for alias in (aliases or []) if alias.strip()]


async def ensure_node(
    session: AsyncSession,
    *,
    name: str,
    kind: str,
    aliases: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
    source: str | None = None,
) -> GraphNode:
    """Find-or-create a node keyed by (kind, normalized name).

    On a hit, aliases are unioned (order-preserving, de-duplicated) and metadata is
    shallow-merged with the incoming values winning — (a plain dict merge). `source` is only set on creation.
    """
    normalized = normalize_name(name)
    existing = (
        await session.execute(
            select(GraphNode)
            .where(GraphNode.kind == kind, GraphNode.normalized_name == normalized)
            .limit(1)
        )
    ).scalar_one_or_none()

    if existing is not None:
        merged_aliases = list(
            dict.fromkeys(_clean_aliases(list(existing.aliases or []) + (aliases or [])))
        )
        existing.name = name
        existing.aliases = merged_aliases
        existing.meta = {**(existing.meta or {}), **(metadata or {})}
        existing.updated_at = _utcnow_naive()
        await session.flush()
        return existing

    created = GraphNode(
        kind=kind,
        name=name,
        normalized_name=normalized,
        aliases=_clean_aliases(aliases),
        meta=metadata or {},
        source=source,
    )
    session.add(created)
    await session.flush()
    return created


async def resolve_node_id(session: AsyncSession, name: str, kind: str | None = None) -> int | None:
    """Look a node up by normalized name or by alias."""
    normalized = normalize_name(name)
    matches = or_(
        GraphNode.normalized_name == normalized,
        # `:normalized = ANY(aliases)` — the modern spelling; ARRAY.any() is
        # deprecated for removal in SQLAlchemy 2.1.
        normalized == any_(GraphNode.aliases),
    )
    clause = (GraphNode.kind == kind, matches) if kind else (matches,)
    return (
        await session.execute(select(GraphNode.id).where(*clause).limit(1))
    ).scalar_one_or_none()


def _node_summary(node: GraphNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "name": node.name,
        "kind": node.kind,
        "aliases": list(node.aliases or []),
    }


def _full_node(node: GraphNode) -> dict[str, Any]:
    """Every column of the node."""
    return {
        "id": node.id,
        "kind": node.kind,
        "name": node.name,
        "normalizedName": node.normalized_name,
        "aliases": list(node.aliases or []),
        "metadata": node.meta,
        "key": node.key,
        "value": node.value,
        "classification": node.classification,
        "tier": node.tier,
        "importance": node.importance,
        "vector": list(node.vector) if node.vector is not None else None,
        "recallCount": node.recall_count,
        "lastRecalledAt": node.last_recalled_at,
        "status": node.status,
        "source": node.source,
        "confidence": node.confidence,
        "createdAt": node.created_at,
        "updatedAt": node.updated_at,
    }


class UpsertGraphNodeArgs(BaseModel):
    name: str = Field(description="Display name for the node")
    kind: NodeKind = Field(description="Entity kind for the node")
    aliases: list[str] | None = Field(
        default=None, description="Alternative spellings/names for lookup"
    )
    metadataJson: str | None = Field(
        default=None, description="JSON object string for additional metadata"
    )


@tool("upsert_graph_node", args_schema=UpsertGraphNodeArgs)
async def upsert_graph_node(
    name: str,
    kind: NodeKind,
    aliases: list[str] | None = None,
    metadataJson: str | None = None,
) -> str:
    """Create or update a knowledge-graph node (person, project, document, task, decision, topic)."""
    from app.db.engine import session_scope

    try:
        metadata: dict[str, Any] | None = None
        if metadataJson:
            try:
                metadata = json.loads(metadataJson)
            except ValueError:
                return "Invalid metadataJson. Provide a valid JSON object string."

        async with session_scope() as session:
            node = await ensure_node(
                session, name=name, kind=kind, aliases=aliases, metadata=metadata
            )
            return dumps(_node_summary(node))
    except Exception as exc:
        logger.error("[knowledge-graph] upsertGraphNode", exc_info=exc)
        return f"Error upserting graph node: {exc}"


class AddGraphFactArgs(BaseModel):
    subject: str = Field(description="Subject entity name")
    subjectKind: NodeKind = Field(description="Subject entity kind")
    relation: str = Field(description="Relation label, e.g. depends_on, decided_in, mentions")
    object: str = Field(description="Object entity name")
    objectKind: NodeKind = Field(description="Object entity kind")
    evidence: str | None = Field(
        default=None, description="Optional source quote or evidence snippet"
    )
    source: str | None = Field(
        default=None, description="Optional source identifier (page URL, doc ID, etc.)"
    )
    subjectAliases: list[str] | None = Field(
        default=None, description="Optional aliases for subject"
    )
    objectAliases: list[str] | None = Field(default=None, description="Optional aliases for object")


@tool("add_graph_fact", args_schema=AddGraphFactArgs)
async def add_graph_fact(
    subject: str,
    subjectKind: NodeKind,
    relation: str,
    object: str,
    objectKind: NodeKind,
    evidence: str | None = None,
    source: str | None = None,
    subjectAliases: list[str] | None = None,
    objectAliases: list[str] | None = None,
) -> str:
    """Create a relation edge between two nodes, creating nodes if needed."""
    from app.db.engine import session_scope

    try:
        normalized_relation = relation.strip().lower()
        async with session_scope() as session:
            subject_node = await ensure_node(
                session, name=subject, kind=subjectKind, aliases=subjectAliases
            )
            object_node = await ensure_node(
                session, name=object, kind=objectKind, aliases=objectAliases
            )

            # `graph_edges_unique` makes re-adding the same fact a no-op; fall back to
            # reading the existing row so the tool still reports the edge id.
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            edge_id = (
                await session.execute(
                    pg_insert(GraphEdge)
                    .values(
                        from_node_id=subject_node.id,
                        to_node_id=object_node.id,
                        relation=normalized_relation,
                        evidence=evidence,
                        source=source,
                    )
                    .on_conflict_do_nothing()
                    .returning(GraphEdge.id)
                )
            ).scalar_one_or_none()

            if edge_id is None:
                edge_id = (
                    await session.execute(
                        select(GraphEdge.id)
                        .where(
                            GraphEdge.from_node_id == subject_node.id,
                            GraphEdge.to_node_id == object_node.id,
                            GraphEdge.relation == normalized_relation,
                        )
                        .limit(1)
                    )
                ).scalar_one()

            return dumps(
                {
                    "edgeId": edge_id,
                    "subject": {
                        "id": subject_node.id,
                        "name": subject_node.name,
                        "kind": subject_node.kind,
                    },
                    "relation": normalized_relation,
                    "object": {
                        "id": object_node.id,
                        "name": object_node.name,
                        "kind": object_node.kind,
                    },
                }
            )
    except Exception as exc:
        logger.error("[knowledge-graph] addGraphFact", exc_info=exc)
        return f"Error adding graph fact: {exc}"


class SearchGraphNodesArgs(BaseModel):
    query: str = Field(description="Text query for matching node names")
    kind: NodeKind | None = Field(default=None, description="Optional entity kind filter")
    limit: int | None = Field(default=None, description="Maximum results to return (default 10)")


@tool("search_graph_nodes", args_schema=SearchGraphNodesArgs)
async def search_graph_nodes(
    query: str, kind: NodeKind | None = None, limit: int | None = None
) -> str:
    """Search graph nodes by name and optional kind."""
    from app.db.engine import session_scope

    try:
        async with session_scope() as session:
            clause = [GraphNode.name.ilike(f"%{query}%")]
            if kind:
                clause.insert(0, GraphNode.kind == kind)
            rows = (
                await session.execute(select(GraphNode).where(*clause).limit(limit or 10))
            ).scalars()
            return dumps([_node_summary(row) for row in rows])
    except Exception as exc:
        logger.error("[knowledge-graph] searchGraphNodes", exc_info=exc)
        return f"Error searching graph nodes: {exc}"


class GetRelatedGraphContextArgs(BaseModel):
    name: str = Field(description="Entity name to center the query")
    kind: NodeKind | None = Field(default=None, description="Optional kind to disambiguate")
    depth: int | None = Field(default=None, description="Traversal depth from 1 to 3 (default 2)")
    limit: int | None = Field(default=None, description="Maximum edges to inspect (default 100)")


@tool("get_related_graph_context", args_schema=GetRelatedGraphContextArgs)
async def get_related_graph_context(
    name: str,
    kind: NodeKind | None = None,
    depth: int | None = None,
    limit: int | None = None,
) -> str:
    """Return nearby graph nodes and edges around an entity."""
    from app.db.engine import session_scope

    try:
        async with session_scope() as session:
            root_id = await resolve_node_id(session, name, kind)
            if root_id is None:
                return dumps({"root": None, "nodes": [], "edges": []})

            max_depth = max(1, min(depth or 2, 3))
            max_edges = max(10, min(limit or 100, 300))

            visited_nodes: set[int] = {root_id}
            visited_edges: set[int] = set()
            frontier: list[int] = [root_id]

            for _level in range(max_depth):
                if not frontier:
                    break
                edges = (
                    await session.execute(
                        select(GraphEdge)
                        .where(
                            or_(
                                GraphEdge.from_node_id.in_(frontier),
                                GraphEdge.to_node_id.in_(frontier),
                            )
                        )
                        .limit(max_edges)
                    )
                ).scalars()

                next_frontier: set[int] = set()
                for edge in edges:
                    visited_edges.add(edge.id)
                    for endpoint in (edge.from_node_id, edge.to_node_id):
                        if endpoint not in visited_nodes:
                            visited_nodes.add(endpoint)
                            next_frontier.add(endpoint)
                frontier = list(next_frontier)

            nodes = (
                (
                    await session.execute(
                        select(GraphNode).where(GraphNode.id.in_(list(visited_nodes)))
                    )
                )
                .scalars()
                .all()
                if visited_nodes
                else []
            )
            edge_rows = (
                (
                    await session.execute(
                        select(GraphEdge).where(GraphEdge.id.in_(list(visited_edges)))
                    )
                )
                .scalars()
                .all()
                if visited_edges
                else []
            )

            node_by_id = {node.id: node for node in nodes}
            root = node_by_id.get(root_id)

            return dumps(
                {
                    # The root is the whole row while the others are
                    # projected; clients rely on that.
                    "root": _full_node(root) if root is not None else None,
                    "nodes": [_node_summary(node) for node in nodes],
                    "edges": [
                        {
                            "id": edge.id,
                            "fromNodeId": edge.from_node_id,
                            "fromName": (
                                node_by_id[edge.from_node_id].name
                                if edge.from_node_id in node_by_id
                                else "Unknown"
                            ),
                            "toNodeId": edge.to_node_id,
                            "toName": (
                                node_by_id[edge.to_node_id].name
                                if edge.to_node_id in node_by_id
                                else "Unknown"
                            ),
                            "relation": edge.relation,
                            "evidence": edge.evidence,
                            "source": edge.source,
                        }
                        for edge in edge_rows
                    ],
                }
            )
    except Exception as exc:
        logger.error("[knowledge-graph] getRelatedGraphContext", exc_info=exc)
        return f"Error fetching related graph context: {exc}"


knowledge_graph_tools = [
    upsert_graph_node,
    add_graph_fact,
    search_graph_nodes,
    get_related_graph_context,
]
