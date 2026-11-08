from __future__ import annotations

import os
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # ─── Required ────────────────────────────────────────────────────────────
    DATABASE_URL: str
    XAI_API_KEY: str
    OPENAI_API_KEY: str
    TAVILY_API_KEY: str
    TELEGRAM_BOT_TOKEN: str
    TELEGRAM_CHAT_ID: str
    GITHUB_TOKEN: str
    GITHUB_USERNAME: str
    GOOGLE_CALENDAR_ID: str
    NOTION_TOKEN: str
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str
    GOOGLE_API_KEY: str

    # ─── Defaulted ───────────────────────────────────────────────────────────
    PORT: int = 3005
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    USER_TIMEZONE: str = "Africa/Lagos"
    OAUTH_REDIRECT_BASE_URL: str = "http://localhost:3005"
    APP_URL: str = "http://localhost:3001"

    # ─── Feature flags ───────────────────────────────────────────────────────
    SCHEDULER_ENABLED: bool = True
    WORKFLOW_LEARNING_ENABLED: bool = True
    AGENT_DEBUG_TOOL_PAYLOADS: bool = False

    # ─── Optional ────────────────────────────────────────────────────────────
    CRON_SECRET: str | None = None
    ANILIST_TOKEN: str | None = None
    GMAIL_REFRESH_TOKEN: str | None = None
    GOOGLE_DOCS_REFRESH_TOKEN: str | None = None
    DEEPGRAM_API_KEY: str | None = None
    VOICE_LLM_SECRET: str | None = None
    PUBLIC_API_URL: str | None = None
    AGENT_SKILLS_DIR: str | None = None
    AGENT_SKILLS_DIRS: str | None = None

    # ─── OAuth app credentials ───────────────────────────────────────────────
    GITHUB_OAUTH_CLIENT_ID: str | None = None
    GITHUB_OAUTH_CLIENT_SECRET: str | None = None
    GOOGLE_OAUTH_CLIENT_ID: str | None = None
    GOOGLE_OAUTH_CLIENT_SECRET: str | None = None
    NOTION_OAUTH_CLIENT_ID: str | None = None
    NOTION_OAUTH_CLIENT_SECRET: str | None = None
    SPOTIFY_OAUTH_CLIENT_ID: str | None = None
    SPOTIFY_OAUTH_CLIENT_SECRET: str | None = None
    TWITTER_OAUTH_CLIENT_ID: str | None = None
    TWITTER_OAUTH_CLIENT_SECRET: str | None = None
    ANILIST_OAUTH_CLIENT_ID: str | None = None
    ANILIST_OAUTH_CLIENT_SECRET: str | None = None
    TODOIST_OAUTH_CLIENT_ID: str | None = None
    TODOIST_OAUTH_CLIENT_SECRET: str | None = None

    @field_validator("USER_TIMEZONE")
    @classmethod
    def _valid_iana_timezone(cls, value: str) -> str:
        """Reject anything that is not a valid IANA timezone."""
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Invalid IANA timezone: {value!r}") from exc
        return value

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.USER_TIMEZONE)

    @property
    def app_url(self) -> str:
        """`APP_URL` with the trailing slash stripped."""
        return self.APP_URL.rstrip("/")

    @property
    def redirect_uri(self) -> str:
        return f"{self.OAUTH_REDIRECT_BASE_URL.rstrip('/')}/oauth/callback"

    def oauth_credential(self, env_name: str) -> str | None:
        """Resolve an OAuth client id/secret by its environment-variable name.

        Falls back to the live environment so an operator can add a provider's
        credentials without this class having to know about it.
        """
        value = getattr(self, env_name, None)
        if value:
            return value
        return os.environ.get(env_name) or None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
