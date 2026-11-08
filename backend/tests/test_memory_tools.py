from __future__ import annotations

from typing import Any

import pytest

from app.tools.memory import (
    IMPORTANCE_BY_CLASSIFICATION,
    RECALL_SIMILARITY_THRESHOLD,
    delete_memory_key,
    determine_tier,
    infer_classification_from_key,
    recall_memories,
    set_memory_key,
)
from tests.conftest import requires_test_db


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("user.name", "identity"),
        ("identity.x", "identity"),
        ("profile.job", "identity"),
        ("relationship.wife", "relationships"),
        ("behavior.tone", "behavior"),
        ("preference.coffee", "preferences"),
        ("Favorite.food", "preferences"),
        ("correction.1", "corrections"),
        ("knowledge.rust", "knowledge"),
        ("random.thing", "unclassified"),
        # The \b-after-alternation quirk: plural prefixes do NOT match. Preserved
        # deliberately.
        ("preferences.coffee", "unclassified"),
        ("relationships.wife", "unclassified"),
    ],
)
def test_infer_classification_from_key(key: str, expected: str) -> None:
    assert infer_classification_from_key(key) == expected


@pytest.mark.parametrize(
    ("classification", "tier"),
    [
        ("identity", "lifelong"),
        ("relationships", "lifelong"),
        ("behavior", "lifelong"),
        ("corrections", "long_term"),
        ("preferences", "long_term"),
        ("knowledge", "long_term"),
        ("unclassified", "short_term"),
    ],
)
def test_determine_tier(classification: str, tier: str) -> None:
    assert determine_tier(classification) == tier


def test_importance_table_is_unchanged() -> None:
    assert IMPORTANCE_BY_CLASSIFICATION == {
        "identity": 0.9,
        "relationships": 0.9,
        "behavior": 0.9,
        "corrections": 0.75,
        "preferences": 0.65,
        "knowledge": 0.65,
        "unclassified": 0.3,
    }
    assert RECALL_SIMILARITY_THRESHOLD == 0.6


@pytest.fixture
def stub_embed(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the OpenAI call with a deterministic embedding.

    Records what was embedded, so the test can assert the *key* is embedded rather
    than the value.
    """
    embedded: list[str] = []

    async def fake_embed(value: str) -> list[float]:
        embedded.append(value)
        # A direction that varies with the text, so similarity ordering is meaningful.
        seed = (sum(ord(c) for c in value) % 50) / 100.0
        return [seed] + [0.01] * 1535

    monkeypatch.setattr("app.tools.memory.embed", fake_embed)
    return embedded


async def _invoke(tool: Any, **kwargs: Any) -> Any:
    return await tool.ainvoke(kwargs)


@requires_test_db
async def test_set_memory_key_inserts_then_updates(api_client: Any, stub_embed: list[str]) -> None:
    result = await _invoke(set_memory_key, key="  user.name  ", value="  Winner  ")
    assert result == 'Stored memory key="user.name" (class=identity, tier=lifelong)'
    assert stub_embed == ["user.name"], "the KEY is embedded, not the value"

    again = await _invoke(set_memory_key, key="user.name", value="Winner X")
    assert again == 'Updated memory key="user.name"'

    recalled = await _invoke(recall_memories, query="user.name")
    assert isinstance(recalled, dict)
    assert recalled["memories"][0]["value"] == "Winner X"
    assert recalled["memories"][0]["classification"] == "identity"


@requires_test_db
async def test_set_memory_key_requires_both_fields(api_client: Any, stub_embed: list[str]) -> None:
    assert await _invoke(set_memory_key, key="   ", value="x") == (
        "Error: key and value are required"
    )
    assert await _invoke(set_memory_key, key="k", value="  ") == (
        "Error: key and value are required"
    )


@requires_test_db
async def test_classification_override_is_respected(api_client: Any, stub_embed: list[str]) -> None:
    result = await _invoke(
        set_memory_key, key="random.thing", value="v", classification="corrections"
    )
    assert result == 'Stored memory key="random.thing" (class=corrections, tier=long_term)'


@requires_test_db
async def test_delete_memory_key(api_client: Any, stub_embed: list[str]) -> None:
    await _invoke(set_memory_key, key="user.city", value="Lagos")
    assert await _invoke(delete_memory_key, key="user.city") == ('Deleted memory key="user.city"')
    assert await _invoke(delete_memory_key, key="user.city") == (
        'No memory found with key="user.city"'
    )
    assert await _invoke(delete_memory_key, key="  ") == "Error: key is required"


@requires_test_db
async def test_recall_reinforces_recalled_rows(api_client: Any, stub_embed: list[str]) -> None:
    """Recall bumps recall_count, stamps last_recalled_at and nudges importance."""
    import psycopg

    from tests.conftest import resolve_test_database_url

    await _invoke(set_memory_key, key="knowledge.rust", value="ownership")
    url = resolve_test_database_url()
    assert url is not None

    def read() -> tuple:
        with psycopg.connect(url) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT recall_count, last_recalled_at, importance FROM graph_nodes "
                "WHERE key = 'knowledge.rust'"
            )
            return cur.fetchone()

    before = read()
    assert before[0] == 0 and before[1] is None

    result = await _invoke(recall_memories, query="knowledge.rust")
    assert result["memories"][0]["key"] == "knowledge.rust"
    assert 0.0 <= result["memories"][0]["similarity"] <= 1.0

    after = read()
    assert after[0] == 1, "recall_count incremented"
    assert after[1] is not None, "last_recalled_at stamped"
    assert after[2] == pytest.approx(before[2] + 0.02, abs=1e-4)


@requires_test_db
async def test_recall_errors_return_a_string_not_a_dict(
    api_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The failure path must stay a string — policy.py pattern-matches on it."""

    async def boom(_value: str) -> list[float]:
        raise RuntimeError("embedding service down")

    monkeypatch.setattr("app.tools.memory.embed", boom)
    result = await _invoke(recall_memories, query="anything")
    assert isinstance(result, str)
    assert result == "Error recalling memories: embedding service down"
