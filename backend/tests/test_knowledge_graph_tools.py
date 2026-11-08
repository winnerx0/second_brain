from __future__ import annotations

import json
from typing import Any

import pytest

from app.tools.knowledge_graph import (
    add_graph_fact,
    get_related_graph_context,
    normalize_name,
    search_graph_nodes,
    upsert_graph_node,
)
from tests.conftest import requires_test_db


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Second   Brain ", "second brain"),
        ("ALPHA beta", "alpha beta"),
        ("tabs\tand\nnewlines", "tabs and newlines"),
        ("x", "x"),
    ],
)
def test_normalize_name(raw: str, expected: str) -> None:
    assert normalize_name(raw) == expected


async def _invoke(tool: Any, **kwargs: Any) -> Any:
    return await tool.ainvoke(kwargs)


@requires_test_db
async def test_upsert_is_find_or_create_on_normalized_name(api_client: Any) -> None:
    first = json.loads(await _invoke(upsert_graph_node, name="Second Brain", kind="project"))
    # Different spacing and case resolve to the same node.
    second = json.loads(await _invoke(upsert_graph_node, name="second   BRAIN", kind="project"))
    assert first["id"] == second["id"]
    # The display name is replaced by the latest spelling.
    assert second["name"] == "second   BRAIN"

    # A different kind is a different node, even with the same name.
    other = json.loads(await _invoke(upsert_graph_node, name="Second Brain", kind="topic"))
    assert other["id"] != first["id"]


@requires_test_db
async def test_upsert_merges_aliases_and_metadata(api_client: Any) -> None:
    await _invoke(
        upsert_graph_node,
        name="Aira",
        kind="project",
        aliases=["aira", "  ", "assistant"],
        metadataJson='{"lang": "ts", "stars": 1}',
    )
    merged = json.loads(
        await _invoke(
            upsert_graph_node,
            name="Aira",
            kind="project",
            aliases=["assistant", "agent"],
            metadataJson='{"lang": "python"}',
        )
    )
    # Blank aliases dropped, duplicates collapsed, order preserved.
    assert merged["aliases"] == ["aira", "assistant", "agent"]

    context = json.loads(await _invoke(get_related_graph_context, name="Aira"))
    # Shallow merge: incoming wins, absent keys survive.
    assert context["root"]["metadata"] == {"lang": "python", "stars": 1}


@requires_test_db
async def test_invalid_metadata_json_is_reported(api_client: Any) -> None:
    result = await _invoke(upsert_graph_node, name="X", kind="other", metadataJson="{not json")
    assert result == "Invalid metadataJson. Provide a valid JSON object string."


@requires_test_db
async def test_add_graph_fact_is_idempotent(api_client: Any) -> None:
    first = json.loads(
        await _invoke(
            add_graph_fact,
            subject="Winner",
            subjectKind="person",
            relation="  WORKS_ON  ",
            object="Second Brain",
            objectKind="project",
            evidence="said so",
        )
    )
    assert first["relation"] == "works_on", "relation is trimmed and lower-cased"

    # graph_edges_unique makes the repeat a no-op, but the edge id is still returned.
    again = json.loads(
        await _invoke(
            add_graph_fact,
            subject="winner",
            subjectKind="person",
            relation="works_on",
            object="second brain",
            objectKind="project",
        )
    )
    assert again["edgeId"] == first["edgeId"]


@requires_test_db
async def test_search_filters_by_name_and_kind(api_client: Any) -> None:
    await _invoke(upsert_graph_node, name="Alpha Project", kind="project")
    await _invoke(upsert_graph_node, name="Alpha Person", kind="person")

    everything = json.loads(await _invoke(search_graph_nodes, query="alpha"))
    assert {row["name"] for row in everything} == {"Alpha Project", "Alpha Person"}

    only_people = json.loads(await _invoke(search_graph_nodes, query="alpha", kind="person"))
    assert [row["name"] for row in only_people] == ["Alpha Person"]

    limited = json.loads(await _invoke(search_graph_nodes, query="alpha", limit=1))
    assert len(limited) == 1


@requires_test_db
async def test_related_context_traverses_and_resolves_aliases(api_client: Any) -> None:
    await _invoke(upsert_graph_node, name="Winner", kind="person", aliases=["winnerx0"])
    await _invoke(
        add_graph_fact,
        subject="Winner",
        subjectKind="person",
        relation="works_on",
        object="Second Brain",
        objectKind="project",
    )
    await _invoke(
        add_graph_fact,
        subject="Second Brain",
        subjectKind="project",
        relation="uses",
        object="Postgres",
        objectKind="other",
    )

    # The root is found via its alias, and depth 2 reaches Postgres.
    deep = json.loads(await _invoke(get_related_graph_context, name="winnerx0", depth=2))
    assert deep["root"]["name"] == "Winner"
    assert {node["name"] for node in deep["nodes"]} == {
        "Winner",
        "Second Brain",
        "Postgres",
    }
    assert {edge["relation"] for edge in deep["edges"]} == {"works_on", "uses"}
    # Edge endpoints are named, not just numbered.
    works_on = next(e for e in deep["edges"] if e["relation"] == "works_on")
    assert works_on["fromName"] == "Winner"
    assert works_on["toName"] == "Second Brain"

    # Depth 1 stops before Postgres.
    shallow = json.loads(await _invoke(get_related_graph_context, name="Winner", depth=1))
    assert {node["name"] for node in shallow["nodes"]} == {"Winner", "Second Brain"}


@requires_test_db
async def test_related_context_for_unknown_entity(api_client: Any) -> None:
    result = json.loads(await _invoke(get_related_graph_context, name="nobody"))
    assert result == {"root": None, "nodes": [], "edges": []}


@requires_test_db
async def test_depth_is_clamped_to_three(api_client: Any) -> None:
    """depth is clamped to [1, 3]; out-of-range values must not error."""
    await _invoke(upsert_graph_node, name="Solo", kind="other")
    for depth in (0, -5, 99):
        result = json.loads(await _invoke(get_related_graph_context, name="Solo", depth=depth))
        assert result["root"]["name"] == "Solo"
