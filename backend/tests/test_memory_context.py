"""Tests for proactive recall.

The output of `build_recall_context` goes straight into the agent's system prompt, so
its exact shape is load-bearing: the header tells the model not to mention the block,
and the arrow notation is how relationships are conveyed.
"""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.memory.context import build_recall_context
from tests.conftest import requires_test_db, resolve_test_database_url

# Embeddings are stubbed, so these only need to be distinguishable directions.
_NEAR = "[" + ",".join(["0.05"] * 1536) + "]"


@pytest.fixture
def stub_embed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_embed(_value: str) -> list[float]:
        return [0.05] * 1536

    monkeypatch.setattr("app.memory.context.embed", fake_embed)


@pytest.fixture
def seeded() -> None:
    url = resolve_test_database_url()
    assert url is not None
    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_nodes
                (id, kind, name, normalized_name, key, value, classification,
                 importance, vector, status)
            VALUES
                (1, 'memory', 'user.name', 'user.name', 'user.name', 'Winner',
                 'identity', 0.9, %s::vector, 'active'),
                (2, 'project', 'Second Brain', 'second brain', NULL, NULL, NULL,
                 0.4, NULL, 'active'),
                (3, 'person', 'Gone', 'gone', NULL, NULL, NULL,
                 0.4, NULL, 'superseded')
            """,
            (_NEAR,),
        )
        cur.execute(
            """
            INSERT INTO graph_edges (from_node_id, to_node_id, relation)
            VALUES (1, 2, 'works_on'), (3, 1, 'knows')
            """
        )


@requires_test_db
async def test_short_messages_skip_recall(api_client: Any, stub_embed: None) -> None:
    """Under three characters there is nothing meaningful to embed."""
    assert await build_recall_context("hi") == ""
    assert await build_recall_context("   ") == ""


@requires_test_db
async def test_no_matches_returns_empty(api_client: Any, stub_embed: None) -> None:
    assert await build_recall_context("tell me about my name") == ""


@requires_test_db
async def test_recall_block_shape(api_client: Any, stub_embed: None, seeded: None) -> None:
    block = await build_recall_context("what is my name")

    lines = block.split("\n")
    assert lines[0] == (
        "Relevant context from memory (auto-recalled — use only if pertinent, "
        "do not mention this block):"
    )
    # A memory node renders as "key: value", with its classification and similarity.
    assert lines[1].startswith("- user.name: Winner [identity] (≈")
    assert lines[1].endswith(")")
    # Its one-hop neighbour is shown with a direction arrow.
    assert lines[2] == "    → works_on Second Brain"


@requires_test_db
async def test_superseded_neighbours_are_excluded(
    api_client: Any, stub_embed: None, seeded: None
) -> None:
    """Node 3 points at the hit but is superseded, so its edge has no label."""
    block = await build_recall_context("what is my name")
    assert "knows" not in block
    assert "Gone" not in block


@requires_test_db
async def test_failure_degrades_to_empty_string(
    api_client: Any, monkeypatch: pytest.MonkeyPatch, seeded: None
) -> None:
    """Chat must not break because recall stumbled."""

    async def boom(_value: str) -> list[float]:
        raise RuntimeError("embeddings unavailable")

    monkeypatch.setattr("app.memory.context.embed", boom)
    assert await build_recall_context("what is my name") == ""
