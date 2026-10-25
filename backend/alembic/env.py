from __future__ import annotations

import asyncio
from logging.config import fileConfig
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine

from alembic import context
from app.config import get_settings
from app.db.engine import create_engine
from app.db.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

UNMANAGED_TABLES = {"linkedin_drafts"}


def include_object(
    _object: Any, name: str | None, type_: str, _reflected: bool, _compare_to: Any
) -> bool:
    if type_ == "table" and name in UNMANAGED_TABLES:
        return False
    return True


def _configure(connection: Any) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=include_object,
        # Catch real-vs-double-precision and timestamp-vs-timestamptz mistakes,
        # both of which this schema is sensitive to.
        compare_type=True,
        # Left off deliberately: Postgres normalises defaults ('{}'::jsonb, 'New
        # Chat'::text, 0.2) in ways that generate permanent false positives. Default
        # correctness is covered instead by inserting rows in the integration tests.
        compare_server_default=False,
        # Keeps Drizzle's own `drizzle.__drizzle_migrations` bookkeeping table, which
        # lives in a separate schema, invisible to autogenerate.
        include_schemas=False,
    )


def run_migrations_offline() -> None:
    context.configure(
        url=get_settings().DATABASE_URL,
        target_metadata=target_metadata,
        include_object=include_object,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection: Any) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def _run_async_migrations() -> None:
    engine: AsyncEngine = create_engine()
    async with engine.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await engine.dispose()


def run_migrations_online() -> None:
    asyncio.run(_run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
