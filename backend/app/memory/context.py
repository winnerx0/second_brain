"""Proactive recall — port of `src/memory/context.ts`.

Before every chat turn the agent prepends the most relevant memories, plus their
one-hop graph neighbours, to its system prompt. That is why the agent can answer
from what it already knows without the model having to decide to call
`recall_memories` first.

Every failure path returns `''`: a chat turn must never break because recall
stumbled.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from app.db.engine import embedding_param, session_scope
from app.logging import get_logger
from app.tools.memory import embed

logger = get_logger("recall-context")

TOP_K = 5
MIN_SIMILARITY = 0.4
#: Edge budget for the one-hop expansion.
MAX_EDGES = 40
#: Relations shown per hit.
MAX_RELATIONS_PER_HIT = 4


def _label(key: str | None, value: str | None, name: str) -> str:
    """Memory nodes read as `key: value`; entity nodes fall back to their name."""
    if key:
        return f"{key}: {value or ''}".strip()
    return name


async def build_recall_context(message: str) -> str:
    """A compact context block for `message`, or `''` when nothing is relevant."""
    try:
        trimmed = message.strip()
        if len(trimmed) < 3:
            return ""

        embedding = embedding_param(await embed(trimmed))
        max_distance = 1 - MIN_SIMILARITY

        async with session_scope() as session:
            hits = (
                await session.execute(
                    text(
                        "SELECT id, kind, key, value, name, classification, "
                        "vector <=> CAST(:embedding AS vector) AS distance "
                        "FROM graph_nodes "
                        "WHERE status = 'active' AND vector IS NOT NULL "
                        "AND vector <=> CAST(:embedding AS vector) <= :max_distance "
                        "ORDER BY vector <=> CAST(:embedding AS vector) "
                        "LIMIT :limit"
                    ),
                    {
                        "embedding": embedding,
                        "max_distance": max_distance,
                        "limit": TOP_K,
                    },
                )
            ).all()

            if not hits:
                return ""

            hit_ids = [hit.id for hit in hits]

            edges = (
                await session.execute(
                    text(
                        "SELECT id, from_node_id, to_node_id, relation FROM graph_edges "
                        "WHERE from_node_id = ANY(:ids) OR to_node_id = ANY(:ids) "
                        "LIMIT :limit"
                    ),
                    {"ids": hit_ids, "limit": MAX_EDGES},
                )
            ).all()

            neighbour_ids = {
                endpoint
                for edge in edges
                for endpoint in (edge.from_node_id, edge.to_node_id)
                if endpoint not in hit_ids
            }

            neighbours: list[Any] = []
            if neighbour_ids:
                neighbours = (
                    await session.execute(
                        text(
                            "SELECT id, key, value, name FROM graph_nodes "
                            "WHERE id = ANY(:ids) AND status <> 'superseded'"
                        ),
                        {"ids": list(neighbour_ids)},
                    )
                ).all()

        name_by_id: dict[int, str] = {hit.id: _label(hit.key, hit.value, hit.name) for hit in hits}
        name_by_id.update({nb.id: _label(nb.key, nb.value, nb.name) for nb in neighbours})

        lines: list[str] = []
        for hit in hits:
            similarity = f"{1 - float(hit.distance):.2f}"
            classification = f" [{hit.classification}]" if hit.classification else ""
            lines.append(
                f"- {_label(hit.key, hit.value, hit.name)}{classification} (≈{similarity})"
            )
            related = [edge for edge in edges if hit.id in (edge.from_node_id, edge.to_node_id)][
                :MAX_RELATIONS_PER_HIT
            ]
            for edge in related:
                outgoing = edge.from_node_id == hit.id
                other_id = edge.to_node_id if outgoing else edge.from_node_id
                other = name_by_id.get(other_id)
                if other:
                    arrow = "→" if outgoing else "←"
                    lines.append(f"    {arrow} {edge.relation} {other}")

        body = "\n".join(lines)
        return (
            "Relevant context from memory (auto-recalled — use only if pertinent, "
            f"do not mention this block):\n{body}"
        )
    except Exception as exc:
        logger.error("[recall-context] failed", exc_info=exc)
        return ""
