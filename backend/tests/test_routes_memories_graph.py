from __future__ import annotations

import httpx
import psycopg
import pytest

from tests.conftest import requires_test_db, resolve_test_database_url

EMBEDDING = "[" + ",".join(["0.01"] * 1536) + "]"


@pytest.fixture
def seeded_graph() -> None:
    """Two memory nodes (one archived), one entity node, and two edges."""
    url = resolve_test_database_url()
    assert url is not None
    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_nodes
                (id, kind, name, normalized_name, key, value, classification, tier,
                 importance, vector, status, source, confidence)
            VALUES
                (1, 'memory', 'user.name', 'user.name', 'user.name', 'Winner',
                 'identity', 'lifelong', 0.9, %s::vector, 'active', 'chat:session:1', 1),
                (2, 'memory', 'user.city', 'user.city', 'user.city', 'Lagos',
                 'identity', 'long_term', 0.5, %s::vector, 'archived', 'agent', 0.8),
                (3, 'project', 'second_brain', 'second_brain', NULL, NULL, NULL, NULL,
                 0.4, NULL, 'active', 'manual', 1)
            """,
            (EMBEDDING, EMBEDDING),
        )
        cur.execute(
            """
            INSERT INTO graph_edges (from_node_id, to_node_id, relation, weight,
                                     confidence, created_by, evidence, source)
            VALUES (1, 3, 'works_on', 2, 0.9, 'agent', 'said so', 'chat:session:1'),
                   (2, 3, 'located_near', 1, 0.5, 'inference', NULL, NULL)
            """
        )


@requires_test_db
async def test_list_memories_only_active_memory_nodes(
    api_client: httpx.AsyncClient, seeded_graph: None
) -> None:
    response = await api_client.get("/memories")
    assert response.status_code == 200
    memories = response.json()["memories"]

    # Node 2 is archived and node 3 is not a memory, so only node 1 is returned.
    assert [m["key"] for m in memories] == ["user.name"]
    assert set(memories[0]) == {
        "id",
        "key",
        "value",
        "classification",
        "tier",
        "importance",
        "createdAt",
        "updatedAt",
    }, "the list projection must not leak vector/aliases/metadata"


@requires_test_db
async def test_patch_memory_returns_the_whole_row(
    api_client: httpx.AsyncClient, seeded_graph: None
) -> None:
    response = await api_client.patch("/memories/1", json={"value": "  Winner X  "})
    assert response.status_code == 200
    memory = response.json()["memory"]
    assert memory["value"] == "Winner X", "value is trimmed"
    # The PATCH response carries the full row; keep that shape.
    for field in ("normalizedName", "aliases", "metadata", "vector", "recallCount", "status"):
        assert field in memory, field
    assert len(memory["vector"]) == 1536


@requires_test_db
async def test_patch_memory_validation_and_404(
    api_client: httpx.AsyncClient, seeded_graph: None
) -> None:
    blank = await api_client.patch("/memories/1", json={"value": "   "})
    assert blank.status_code == 400
    assert blank.json() == {"error": "value is required"}

    # Node 3 exists but is not a memory, so it must not be reachable here.
    wrong_kind = await api_client.patch("/memories/3", json={"value": "nope"})
    assert wrong_kind.status_code == 404
    assert wrong_kind.json() == {"error": "Memory not found"}

    missing = await api_client.delete("/memories/999")
    assert missing.status_code == 404
    assert missing.json() == {"error": "Memory not found"}


@requires_test_db
async def test_graph_filters_edges_to_returned_nodes(
    api_client: httpx.AsyncClient, seeded_graph: None
) -> None:
    active = await api_client.get("/graph")
    assert active.status_code == 200
    body = active.json()
    assert {n["id"] for n in body["nodes"]} == {1, 3}
    # The 2->3 edge is dropped because node 2 is archived and so absent.
    assert [e["relation"] for e in body["edges"]] == ["works_on"]
    assert set(body["edges"][0]) == {
        "id",
        "fromNodeId",
        "toNodeId",
        "relation",
        "weight",
        "confidence",
        "createdBy",
    }

    everything = await api_client.get("/graph", params={"status": "all"})
    assert {n["id"] for n in everything.json()["nodes"]} == {1, 2, 3}
    assert len(everything.json()["edges"]) == 2

    by_kind = await api_client.get("/graph", params={"kind": "memory"})
    assert {n["id"] for n in by_kind.json()["nodes"]} == {1}
    assert by_kind.json()["edges"] == [], "both endpoints must survive the filter"
