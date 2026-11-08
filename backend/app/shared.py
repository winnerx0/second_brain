from __future__ import annotations

from functools import lru_cache

from langchain_xai import ChatXAI

from app.config import get_settings


@lru_cache(maxsize=1)
def get_model() -> ChatXAI:
    settings = get_settings()
    return ChatXAI(
        api_key=settings.XAI_API_KEY,
        model="grok-4-1-fast-reasoning",
        temperature=0.8,
        max_tokens=5000,
        max_retries=3,
    )
