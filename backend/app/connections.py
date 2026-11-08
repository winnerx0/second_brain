from __future__ import annotations

from sqlalchemy import select

from app.db.engine import session_scope
from app.db.models import Connection
from app.logging import get_logger

logger = get_logger("connections")

#: Seeded on startup if absent. Order matters only for the `ORDER BY id` listing.
BUILT_IN_CONNECTIONS: tuple[tuple[str, str], ...] = (
    ("github", "GitHub"),
    ("gmail", "Gmail"),
    ("google_calendar", "Google Calendar"),
    ("notion", "Notion"),
    ("anilist", "AniList"),
    ("google_docs", "Google Docs"),
    ("knowledge_graph", "Knowledge Graph"),
    ("spotify", "Spotify"),
    ("clickup", "ClickUp"),
    ("todoist", "Todoist"),
    ("twitter", "Twitter / X"),
)

#: Providers authenticated with a pasted API key rather than OAuth. The key is stored
#: in the same `access_token` column.
API_KEY_CONNECTIONS = frozenset({"clickup"})

#: Retired providers. Rows may still exist, but they are hidden from the API.
REMOVED_CONNECTIONS = frozenset({"linkedin"})


async def seed_connections() -> None:
    """Insert any missing built-in connections.

    Runs in the FastAPI lifespan instead of at import time so the app stays importable
    without a reachable database. The warn-and-continue fallback is kept: a missing table must
    not stop the process from starting.
    """
    try:
        async with session_scope() as session:
            existing = set((await session.execute(select(Connection.name))).scalars())
            missing = [(n, label) for n, label in BUILT_IN_CONNECTIONS if n not in existing]
            if not missing:
                return
            session.add_all([Connection(name=name, label=label) for name, label in missing])
        logger.info("[connections] seeded %d connection(s)", len(missing))
    except Exception as exc:
        logger.warning(
            "[connections] seed skipped — table may not exist yet: %s",
            exc,
        )
