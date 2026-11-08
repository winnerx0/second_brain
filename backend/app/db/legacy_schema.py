from __future__ import annotations

from pathlib import Path

STATEMENT_BREAKPOINT = "--> statement-breakpoint"

SQL_DIR = Path(__file__).resolve().parents[2] / "sql"


def migration_files(up_to: str | None = None) -> list[Path]:
    """Baseline schema files in apply order, optionally stopping at a prefix."""
    files = sorted(p for p in SQL_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if up_to is not None:
        files = [p for p in files if p.name[:4] <= up_to]
    return files


def statements(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    return [chunk.strip() for chunk in raw.split(STATEMENT_BREAKPOINT) if chunk.strip()]


def all_statements(up_to: str | None = None) -> list[str]:
    return [stmt for path in migration_files(up_to) for stmt in statements(path)]
