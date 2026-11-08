from __future__ import annotations

from sqlalchemy import select

from app.config import get_settings
from app.db.engine import session_scope
from app.db.models import Connection
from app.workflows.types import Definition


async def connection_issues(definition: Definition | None) -> list[str]:
    if definition is None:
        return []

    settings = get_settings()
    async with session_scope() as session:
        rows = (await session.execute(select(Connection.name, Connection.oauth_connected))).all()
    connected = {row.name for row in rows if row.oauth_connected}

    available: dict[str, bool] = {
        # These accept either an OAuth connection or a configured token.
        "github": "github" in connected or bool(settings.GITHUB_TOKEN),
        "notion": "notion" in connected or bool(settings.NOTION_TOKEN),
        "calendar": "google_calendar" in connected,
        "docs": "google_docs" in connected or bool(settings.GOOGLE_DOCS_REFRESH_TOKEN),
        "gmail": "gmail" in connected or bool(settings.GMAIL_REFRESH_TOKEN),
        "clickup": "clickup" in connected,
        "spotify": "spotify" in connected,
        "twitter": "twitter" in connected,
        "web_search": bool(settings.TAVILY_API_KEY),
        "telegram": bool(settings.TELEGRAM_BOT_TOKEN) and bool(settings.TELEGRAM_CHAT_ID),
        "synthesis": True,
        "knowledge_graph": True,
        # Public AniList reads do not require authorization.
        "anilist": True,
    }

    # De-duplicated, preserving first-seen order.
    issues = list(
        dict.fromkeys(
            f"Connect {step.specialist} before running this workflow."
            for step in definition.steps
            if not available.get(step.specialist, False)
        )
    )

    # AniList reads are public, but account *writes* need a token.
    if (
        any(step.specialist == "anilist" and step.permissions for step in definition.steps)
        and "anilist" not in connected
        and not settings.ANILIST_TOKEN
    ):
        issues.append("Connect AniList before running account actions.")

    return issues
