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
