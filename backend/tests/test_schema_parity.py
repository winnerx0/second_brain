from __future__ import annotations

from typing import Any

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.models import Base
from tests.conftest import requires_test_db

# Mirrors `UNMANAGED_TABLES` in alembic/env.py.
UNMANAGED_TABLES = {"linkedin_drafts"}


def _include_object(
    _obj: Any, name: str | None, type_: str, _reflected: bool, _compare_to: Any
) -> bool:
    return not (type_ == "table" and name in UNMANAGED_TABLES)


def _diff(sync_connection: Any) -> list[Any]:
    context = MigrationContext.configure(
        sync_connection,
        opts={
            "compare_type": True,
            "compare_server_default": False,
            "include_schemas": False,
            "include_object": _include_object,
        },
    )
    return compare_metadata(context, Base.metadata)


@requires_test_db
async def test_models_match_baseline_schema(legacy_engine: AsyncEngine) -> None:
    async with legacy_engine.connect() as conn:
        diffs = await conn.run_sync(_diff)
    assert diffs == [], "\n".join(repr(d) for d in diffs)
