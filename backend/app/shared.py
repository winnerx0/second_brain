"""The chat model singleton — port of `src/shared.ts`.

`src/shared.ts` also carried commented-out `ChatOpenAI` (gpt-5-nano) and
`ChatOpenRouter` (openrouter/owl-alpha) alternatives. Those providers were never
imported by live code, so neither `langchain-openrouter` nor its config is carried
over; swapping the model is a one-line change here.

`langchain-openai` *is* a dependency, but only because `app/memory/cleanup.py` runs
its three-model debate on gpt-5-nano.
"""

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
