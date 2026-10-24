"""Replay the pre-migration Drizzle SQL into a database.

The production schema was built by `backend/drizzle/*.sql`, so those files are the
authoritative record of what `app/db/models.py` must match. Two things use this:

* `tests/test_schema_parity.py`, which builds a throwaway database here and asserts
  Alembic finds no difference against the models;
* the port of `src/workflows/integration.test.ts`, which did the same thing in
  TypeScript to prove migrations preserve existing workflows.

Drizzle separates statements within a file using a `--> statement-breakpoint`
comment, which is not valid SQL on its own and has to be split out.
"""

from __future__ import annotations

from pathlib import Path

STATEMENT_BREAKPOINT = "--> statement-breakpoint"

DRIZZLE_DIR = Path(__file__).resolve().parents[2] / "drizzle"


def migration_files(up_to: str | None = None) -> list[Path]:
    """Drizzle migration files in apply order, optionally stopping at a prefix."""
    files = sorted(p for p in DRIZZLE_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if up_to is not None:
        files = [p for p in files if p.name[:4] <= up_to]
    return files


def statements(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    return [chunk.strip() for chunk in raw.split(STATEMENT_BREAKPOINT) if chunk.strip()]


def all_statements(up_to: str | None = None) -> list[str]:
    return [stmt for path in migration_files(up_to) for stmt in statements(path)]
