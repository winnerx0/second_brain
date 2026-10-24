"""baseline: adopt the existing Drizzle-created schema

Intentionally empty. The schema this project starts from was created by
`backend/drizzle/0000_late_quentin_quire.sql` .. `0006_scheduled_workflows.sql`
and already exists in every environment. Rather than re-issuing that DDL, the
live database is told it is already at this revision:

    DATABASE_URL=... uv run alembic stamp head

`app/db/models.py` is asserted to match the result; see
`tests/test_schema_parity.py`. Real migrations start at the next revision.

Revision ID: 0001_baseline
Revises:
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """No-op: the schema predates Alembic."""


def downgrade() -> None:
    raise NotImplementedError(
        "The baseline revision cannot be reversed; it represents a pre-existing schema."
    )
