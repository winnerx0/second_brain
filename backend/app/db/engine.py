"""Async engine and session factory — port of `src/db/client.ts`.

`src/db/client.ts` stripped `sslmode=` out of `DATABASE_URL` and translated it into
node-postgres' `ssl: {rejectUnauthorized: true}`, because node-postgres cannot parse
libpq connection parameters. psycopg 3 is libpq-based and accepts `sslmode` directly,
so that workaround is deleted rather than ported — the URL is passed through as-is
apart from the driver prefix.

The session factory replaces Drizzle's `db`; `sql_transaction()` and `fetch_all()`
replace the raw `pool.query` / `sqlTransaction` call sites in `src/workflows/`.

No psycopg `vector` type adapter is registered. ORM access goes through
`pgvector.sqlalchemy.Vector`, which converts values itself, and the raw similarity
queries bind the embedding as a JSON string with an explicit `::vector` cast — the
same thing `src/memory/context.ts` and `src/tools/memory.ts` already do:

    ORDER BY vector <=> :embedding::vector

`embedding_param()` below produces that string.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings


def to_async_url(database_url: str) -> str:
    """Point the URL at the psycopg3 driver, preserving every query parameter."""
    for prefix in ("postgresql+psycopg://", "postgres+psycopg://"):
        if database_url.startswith(prefix):
            return database_url
    for prefix in ("postgresql://", "postgres://"):
        if database_url.startswith(prefix):
            return "postgresql+psycopg://" + database_url[len(prefix) :]
    return database_url


def create_engine(database_url: str | None = None) -> AsyncEngine:
    settings = get_settings()
    engine = create_async_engine(
        to_async_url(database_url or settings.DATABASE_URL),
        pool_size=10,
        max_overflow=10,
        pool_pre_ping=True,
        # Every timestamp this service reads or writes is interpreted as UTC. The
        # schema mixes naive `timestamp` and `timestamptz` columns, so letting the
        # session timezone drift would shift workflow schedules.
        connect_args={"options": "-c timezone=UTC"},
    )
    return engine


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_engine()
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Commit-on-success session, the Drizzle `db` equivalent for ORM call sites."""
    async with get_sessionmaker()() as session:
        async with session.begin():
            yield session


@asynccontextmanager
async def sql_transaction() -> AsyncIterator[AsyncConnection]:
    """BEGIN/COMMIT around raw SQL — replaces `sqlTransaction` in `workflows/service.ts`."""
    async with get_engine().begin() as conn:
        yield conn


async def fetch_all(query: str, params: dict[str, Any] | None = None) -> Sequence[Row[Any]]:
    """One-shot raw query — replaces a bare `pool.query(...)`."""
    async with get_engine().connect() as conn:
        result = await conn.execute(text(query), params or {})
        return result.fetchall()


async def execute(query: str, params: dict[str, Any] | None = None) -> int:
    """One-shot raw statement in its own transaction; returns affected row count."""
    async with get_engine().begin() as conn:
        result = await conn.execute(text(query), params or {})
        return result.rowcount


def embedding_param(embedding: Sequence[float]) -> str:
    """Render an embedding for a `:param::vector` bind.

    Mirrors ``JSON.stringify(embedding)`` in the TypeScript, which is also what
    Postgres' `vector` input parser accepts.
    """
    return "[" + ",".join(repr(float(value)) for value in embedding) + "]"
