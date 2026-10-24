"""Prove the models can *reproduce* the real schema, not just fail to differ from it.

`tests/test_schema_parity.py` relies on Alembic's `compare_metadata`, which does not
compare partial-index predicates: deleting the `WHERE status IN ('queued','running')`
clause from `workflow_one_active` leaves that test green. That clause is what enforces
"one active run per workflow", so losing it would let a workflow run twice
concurrently — exactly the failure the index exists to prevent.

This test closes the gap by building a second database from `Base.metadata` alone and
diffing Postgres' own rendering of the indexes and constraints against the
Drizzle-built schema. Both sides are rendered by Postgres, so predicates that are
written differently but mean the same thing compare equal, while a missing or
altered predicate shows up immediately.
"""

from __future__ import annotations

import psycopg
import pytest

from app.db.models import Base
from tests.conftest import (
    rebuild_legacy_schema,
    requires_test_db,
    resolve_test_database_url,
)

MODEL_DB = "aira_model_roundtrip"

# `linkedin_drafts` is intentionally unmodelled (see app/db/models.py).
UNMANAGED_TABLES = {"linkedin_drafts"}

INDEX_QUERY = """
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
"""

CONSTRAINT_QUERY = """
    SELECT rel.relname AS tablename,
           con.conname  AS constraintname,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public'
    ORDER BY rel.relname, con.conname
"""


def _admin_url(url: str, database: str) -> str:
    base, _, _ = url.rpartition("/")
    return f"{base}/{database}"


def _rows(url: str, query: str) -> set[tuple[str, str, str]]:
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(query)
        return {
            (table, name, definition)
            for table, name, definition in cur.fetchall()
            if table not in UNMANAGED_TABLES
        }


def _build_from_models(url: str) -> None:
    """Create the schema from `Base.metadata` in an empty database.

    The two native enums and the `vector` extension are created by hand because the
    models declare the enums with `create_type=False` (they already exist in every
    real environment, so the models must never try to re-create them).
    """
    from sqlalchemy import create_engine as create_sync_engine

    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute(
            "CREATE TYPE memory_classification AS ENUM "
            "('identity','relationships','behavior','preferences',"
            "'corrections','knowledge','unclassified')"
        )
        cur.execute("CREATE TYPE memory_tier AS ENUM ('short_term','long_term','lifelong')")

    engine = create_sync_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    try:
        Base.metadata.create_all(engine)
    finally:
        engine.dispose()


@pytest.fixture
def model_built_url() -> str:
    url = resolve_test_database_url()
    assert url is not None
    maintenance = _admin_url(url, "postgres")
    with psycopg.connect(maintenance, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(f'DROP DATABASE IF EXISTS "{MODEL_DB}"')
        cur.execute(f'CREATE DATABASE "{MODEL_DB}"')
    model_url = _admin_url(url, MODEL_DB)
    _build_from_models(model_url)
    return model_url


@requires_test_db
def test_indexes_match(model_built_url: str) -> None:
    drizzle_url = resolve_test_database_url()
    assert drizzle_url is not None
    rebuild_legacy_schema(drizzle_url)

    expected = _rows(drizzle_url, INDEX_QUERY)
    actual = _rows(model_built_url, INDEX_QUERY)

    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    assert not missing and not extra, (
        "\nmissing from models:\n  "
        + "\n  ".join(map(str, missing))
        + "\nnot in real schema:\n  "
        + "\n  ".join(map(str, extra))
    )


@requires_test_db
def test_constraints_match(model_built_url: str) -> None:
    drizzle_url = resolve_test_database_url()
    assert drizzle_url is not None
    rebuild_legacy_schema(drizzle_url)

    expected = _rows(drizzle_url, CONSTRAINT_QUERY)
    actual = _rows(model_built_url, CONSTRAINT_QUERY)

    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    assert not missing and not extra, (
        "\nmissing from models:\n  "
        + "\n  ".join(map(str, missing))
        + "\nnot in real schema:\n  "
        + "\n  ".join(map(str, extra))
    )
