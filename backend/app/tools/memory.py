from __future__ import annotations

import datetime as dt
import re
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.config import get_settings
from app.db.engine import embedding_param, session_scope
from app.logging import get_logger

logger = get_logger("memory")

MEMORY_KIND = "memory"

Classification = Literal[
    "identity",
    "relationships",
    "behavior",
    "preferences",
    "corrections",
    "knowledge",
    "unclassified",
]

CLASSIFICATIONS: tuple[str, ...] = (
    "identity",
    "relationships",
    "behavior",
    "preferences",
    "corrections",
    "knowledge",
    "unclassified",
)

IMPORTANCE_BY_CLASSIFICATION: dict[str, float] = {
    "identity": 0.9,
    "relationships": 0.9,
    "behavior": 0.9,
    "corrections": 0.75,
    "preferences": 0.65,
    "knowledge": 0.65,
    "unclassified": 0.3,
}

LIFELONG_CLASSIFICATIONS = frozenset({"identity", "relationships", "behavior"})

#: Cosine similarity floor for recall; the query uses the distance equivalent.
RECALL_SIMILARITY_THRESHOLD = 0.6
RECALL_LIMIT = 8

#: Key-prefix heuristics for classifying a memory key.
#:
#: Note the `\b` after each alternation: it means only the *singular* prefix matches.
#: 'preference.coffee' classifies as preferences, but 'preferences.coffee' does not —
#: the trailing 's' is a word character, so the boundary fails and the key falls
#: through to 'unclassified'. The same applies to 'relationships.'. This is long-standing
#: behaviour and `set_memory_key`'s own
#: description suggests 'preferences.coffee' as an example key. Preserved because
#: changing it would silently reclassify and re-tier existing memories; see
#: tests/test_memory_tools.py.
_KEY_CLASSIFICATION_PATTERNS: tuple[tuple[str, Classification], ...] = (
    (r"^(identity|user|profile|name|age|birthday|location|job|address)\b", "identity"),
    (r"^(relationship|family|friend|partner|colleague|manager)\b", "relationships"),
    (r"^(behavior|tone|style|response|reply)\b", "behavior"),
    (r"^(preference|likes|dislikes|favorite)\b", "preferences"),
    (r"^(correction)\b", "corrections"),
    (r"^(knowledge|skill|expertise|learned)\b", "knowledge"),
)


def importance_for_classification(classification: str) -> float:
    return IMPORTANCE_BY_CLASSIFICATION[classification]


def determine_tier(classification: str) -> str:
    importance = importance_for_classification(classification)
    if classification in LIFELONG_CLASSIFICATIONS and importance >= 0.85:
        return "lifelong"
    if importance >= 0.55:
        return "long_term"
    return "short_term"


def infer_classification_from_key(key: str) -> Classification:
    lowered = key.lower()
    for pattern, classification in _KEY_CLASSIFICATION_PATTERNS:
        if re.search(pattern, lowered):
            return classification
    return "unclassified"


async def embed(value: str) -> list[float]:
    """Embed text with the configured OpenAI model."""
    from openai import AsyncOpenAI

    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
    response = await client.embeddings.create(model=settings.EMBEDDING_MODEL, input=value)
    return list(response.data[0].embedding)


def _utcnow_naive() -> dt.datetime:
    """`graph_nodes` timestamps are naive columns; write naive UTC."""
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


class SetMemoryKeyArgs(BaseModel):
    key: str = Field(min_length=1, description='Stable globally-unique key, e.g. "user.name"')
    value: str = Field(min_length=1, description="Value to store under the key")
    classification: Classification | None = Field(
        default=None,
        description="Optional classification override; inferred from the key when omitted",
    )


@tool("set_memory_key", args_schema=SetMemoryKeyArgs)
async def set_memory_key(key: str, value: str, classification: Classification | None = None) -> str:
    """Store or update a memory entry by key. Pick a stable, descriptive, dot-separated key (e.g. "user.name", "user.full_name", "preferences.coffee"). If the key already exists, its value is overwritten."""
    try:
        trimmed_key = key.strip()
        trimmed_value = value.strip()
        if not trimmed_key or not trimmed_value:
            return "Error: key and value are required"

        final_classification = classification or infer_classification_from_key(trimmed_key)
        importance = importance_for_classification(final_classification)
        tier = determine_tier(final_classification)
        now = _utcnow_naive()
        embedding = embedding_param(await embed(trimmed_key))

        async with session_scope() as session:
            existing = (
                await session.execute(
                    text("SELECT id FROM graph_nodes WHERE kind = :kind AND key = :key LIMIT 1"),
                    {"kind": MEMORY_KIND, "key": trimmed_key},
                )
            ).scalar_one_or_none()

            if existing is not None:
                await session.execute(
                    text(
                        "UPDATE graph_nodes SET name = :name, normalized_name = :normalized, "
                        "value = :value, classification = :classification, tier = :tier, "
                        "importance = :importance, status = 'active', "
                        "vector = CAST(:embedding AS vector), updated_at = :now "
                        "WHERE id = :id"
                    ),
                    {
                        "name": trimmed_key,
                        "normalized": trimmed_key.lower(),
                        "value": trimmed_value,
                        "classification": final_classification,
                        "tier": tier,
                        "importance": importance,
                        "embedding": embedding,
                        "now": now,
                        "id": existing,
                    },
                )
                logger.info("[memory] updated key=%s (id=%s)", trimmed_key, existing)
                return f'Updated memory key="{trimmed_key}"'

            inserted = (
                await session.execute(
                    text(
                        "INSERT INTO graph_nodes (kind, name, normalized_name, key, value, "
                        "classification, tier, importance, status, source, vector, "
                        "created_at, updated_at) "
                        "VALUES (:kind, :name, :normalized, :key, :value, :classification, "
                        ":tier, :importance, 'active', 'agent', CAST(:embedding AS vector), "
                        ":now, :now) RETURNING id"
                    ),
                    {
                        "kind": MEMORY_KIND,
                        "name": trimmed_key,
                        "normalized": trimmed_key.lower(),
                        "key": trimmed_key,
                        "value": trimmed_value,
                        "classification": final_classification,
                        "tier": tier,
                        "importance": importance,
                        "embedding": embedding,
                        "now": now,
                    },
                )
            ).scalar_one_or_none()

        logger.info("[memory] inserted key=%s (id=%s)", trimmed_key, inserted)
        return f'Stored memory key="{trimmed_key}" (class={final_classification}, tier={tier})'
    except Exception as exc:
        logger.error("[memory.set]", exc_info=exc)
        return f"Error setting memory: {exc}"


class DeleteMemoryKeyArgs(BaseModel):
    key: str = Field(min_length=1, description="Exact key to delete")


@tool("delete_memory_key", args_schema=DeleteMemoryKeyArgs)
async def delete_memory_key(key: str) -> str:
    """Delete a memory entry by its exact key."""
    try:
        trimmed = key.strip()
        if not trimmed:
            return "Error: key is required"

        async with session_scope() as session:
            deleted = (
                await session.execute(
                    text("DELETE FROM graph_nodes WHERE kind = :kind AND key = :key RETURNING id"),
                    {"kind": MEMORY_KIND, "key": trimmed},
                )
            ).all()

        if not deleted:
            return f'No memory found with key="{trimmed}"'
        logger.info("[memory] deleted key=%s", trimmed)
        return f'Deleted memory key="{trimmed}"'
    except Exception as exc:
        logger.error("[memory.delete]", exc_info=exc)
        return f"Error deleting memory: {exc}"


class RecallMemoriesArgs(BaseModel):
    query: str = Field(description="Semantic query for recall")


@tool("recall_memories", args_schema=RecallMemoriesArgs)
async def recall_memories(query: str) -> dict[str, Any] | str:
    """Retrieve memories whose keys are semantically close to the query. Returns key/value pairs."""
    try:
        embedding = embedding_param(await embed(query))
        max_distance = 1 - RECALL_SIMILARITY_THRESHOLD

        async with session_scope() as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT id, key, value, classification, tier, importance, "
                        "vector <=> CAST(:embedding AS vector) AS distance "
                        "FROM graph_nodes "
                        "WHERE kind = :kind AND status = 'active' AND vector IS NOT NULL "
                        "AND vector <=> CAST(:embedding AS vector) <= :max_distance "
                        "ORDER BY vector <=> CAST(:embedding AS vector) "
                        "LIMIT :limit"
                    ),
                    {
                        "embedding": embedding,
                        "kind": MEMORY_KIND,
                        "max_distance": max_distance,
                        "limit": RECALL_LIMIT,
                    },
                )
            ).all()

            if rows:
                # Reinforce what was just used: recall bookkeeping plus a small
                # importance bump, capped so recall alone cannot reach 1.0.
                await session.execute(
                    text(
                        "UPDATE graph_nodes SET recall_count = recall_count + 1, "
                        "last_recalled_at = :now, "
                        "importance = LEAST(0.95, importance + 0.02) "
                        "WHERE id = ANY(:ids)"
                    ),
                    {"now": _utcnow_naive(), "ids": [row.id for row in rows]},
                )

        return {
            "memories": [
                {
                    "key": row.key,
                    "value": row.value,
                    "classification": row.classification,
                    "tier": row.tier,
                    "importance": row.importance,
                    "similarity": round(1 - float(row.distance), 3),
                }
                for row in rows
            ]
        }
    except Exception as exc:
        logger.error("[memory.recall]", exc_info=exc)
        return f"Error recalling memories: {exc}"


memory_tools = [set_memory_key, delete_memory_key, recall_memories]
