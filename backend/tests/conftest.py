from __future__ import annotations

import os
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import httpx
import psycopg
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.engine import create_engine
from app.db.legacy_schema import migration_files, statements

ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}
ALLOWED_DB_NAMES = {"workflow_test", "aira_probe"}

REQUIRED_ENV_PLACEHOLDERS = {
    "DATABASE_URL": "postgresql://localhost/workflow_test",
    "XAI_API_KEY": "test-placeholder",
    "OPENAI_API_KEY": "test-placeholder",
    "TAVILY_API_KEY": "test-placeholder",
    "TELEGRAM_BOT_TOKEN": "test-placeholder",
    "TELEGRAM_CHAT_ID": "test-placeholder",
    "GITHUB_TOKEN": "test-placeholder",
    "GITHUB_USERNAME": "test-placeholder",
    "GOOGLE_CALENDAR_ID": "test-placeholder",
    "NOTION_TOKEN": "test-placeholder",
    "GOOGLE_CLIENT_ID": "test-placeholder",
    "GOOGLE_CLIENT_SECRET": "test-placeholder",
    "GOOGLE_API_KEY": "test-placeholder",
}


def resolve_test_database_url() -> str | None:
    """The opt-in test database URL, validated. Never falls back to DATABASE_URL."""
    url = os.environ.get("WORKFLOW_TEST_DATABASE_URL")
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.hostname not in ALLOWED_HOSTS:
        raise RuntimeError(
            f"WORKFLOW_TEST_DATABASE_URL host must be local, got {parsed.hostname!r}"
        )
    name = (parsed.path or "").lstrip("/")
    if name not in ALLOWED_DB_NAMES:
        raise RuntimeError(
            f"WORKFLOW_TEST_DATABASE_URL database must be one of "
            f"{sorted(ALLOWED_DB_NAMES)}, got {name!r}"
        )
    return url


requires_test_db = pytest.mark.skipif(
    resolve_test_database_url() is None,
    reason="set WORKFLOW_TEST_DATABASE_URL to a local workflow_test/aira_probe database",
)


@pytest.fixture(autouse=True)
def _stub_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Satisfy the settings schema without needing a populated .env."""
    for key, value in REQUIRED_ENV_PLACEHOLDERS.items():
        monkeypatch.setenv(key, os.environ.get(key) or value)
    from app.config import get_settings

    get_settings.cache_clear()


def rebuild_legacy_schema(url: str, up_to: str | None = None) -> None:
    """Recreate `public` from the baseline SQL. Only ever run against a guarded URL."""
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        for path in migration_files(up_to):
            for stmt in statements(path):
                with conn.cursor() as cur:
                    cur.execute(stmt)


@pytest_asyncio.fixture
async def legacy_engine() -> AsyncIterator[AsyncEngine]:
    """An engine over a database built from the frozen baseline SQL."""
    url = resolve_test_database_url()
    assert url is not None
    rebuild_legacy_schema(url)
    engine = create_engine(url)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def api_client() -> AsyncIterator[httpx.AsyncClient]:
    """Drive the ASGI app in-process against the guarded test database.

    `ASGITransport` deliberately does not run the lifespan, so the workflow worker
    never starts and `seed_connections()` does not fire — which is what contract tests
    want. Tests that need seeded rows insert them explicitly.
    """
    url = resolve_test_database_url()
    assert url is not None
    rebuild_legacy_schema(url)

    import app.db.engine as engine_module
    from app.config import get_settings

    os.environ["DATABASE_URL"] = url
    get_settings.cache_clear()
    await engine_module.dispose_engine()

    from app.main import create_app

    application = create_app()
    transport = httpx.ASGITransport(app=application)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        try:
            yield client
        finally:
            await engine_module.dispose_engine()
