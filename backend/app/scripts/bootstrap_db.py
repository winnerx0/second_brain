from __future__ import annotations

import sys

import psycopg
from alembic.config import Config

from alembic import command
from app.config import get_settings
from app.db.legacy_schema import migration_files, statements
from app.logging import configure_logging, get_logger

logger = get_logger("bootstrap")

#: Any table from the pre-Alembic schema; its presence means the schema exists.
SENTINEL_TABLE = "graph_nodes"


def _alembic_config() -> Config:
    config = Config("alembic.ini")
    config.set_main_option("script_location", "alembic")
    return config


def _inspect(url: str) -> tuple[bool, bool]:
    """Return (has_alembic_version, has_schema)."""
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.alembic_version') IS NOT NULL")
        has_version = bool(cur.fetchone()[0])
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{SENTINEL_TABLE}",))
        has_schema = bool(cur.fetchone()[0])
    return has_version, has_schema


def _replay_baseline_sql(url: str) -> None:
    files = migration_files()
    if not files:
        raise RuntimeError(
            "No sql/*.sql files found; cannot build the schema for an empty database."
        )
    with psycopg.connect(url, autocommit=True) as conn:
        for path in files:
            for statement in statements(path):
                with conn.cursor() as cur:
                    cur.execute(statement)
            logger.info("[bootstrap] applied %s", path.name)


def main() -> int:
    configure_logging()
    url = get_settings().DATABASE_URL
    config = _alembic_config()

    has_version, has_schema = _inspect(url)

    if has_version:
        logger.info("[bootstrap] already under Alembic; upgrading")
        command.upgrade(config, "head")
        return 0

    if has_schema:
        logger.info("[bootstrap] adopting existing schema; stamping baseline")
    else:
        logger.info("[bootstrap] empty database; replaying baseline SQL")
        _replay_baseline_sql(url)

    command.stamp(config, "head")
    command.upgrade(config, "head")
    logger.info("[bootstrap] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
