from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.json import dumps
from app.tools.anilist import add_list_entry, anilist_tools
from app.workflows.context import current_execution

STATUS_VALUES = ("CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING")

ANILIST_SYSTEM_PROMPT = """You are an Anime & Manga Guide with access to AniList.

When helping users:
- Search for anime/manga by title, genre, tag, season, status, popularity, score, or trending rank
- Use get_anilist_genres_and_tags when the user asks for genre/tag-driven discovery and the exact tag name matters
- Use get_anime/get_manga for detail questions after resolving a title to a media ID
- Use get_airing_schedule for upcoming episodes or "when does this air?"
- Use character, staff, and studio search tools for people/studio questions
- Provide accurate information: episode/chapter counts, airing status, scores, descriptions, relations, studios, and list state
- For authenticated account actions (rating/list/progress/favourite updates), perform the action directly when the request is explicit and low risk
- If a user says "update my rating" or "set progress" and gives a title, resolve the title to mediaId first, then use add_list_entry/update_list_entry
- Use get_media_list_entry before updating or deleting when only a title/mediaId is known and an entry ID is needed
- Ask for confirmation before removing list entries or toggling favourites
- If required details are genuinely missing (e.g., ambiguous title), ask exactly one concise clarifying question
- Respect spoiler boundaries — never reveal plot twists or major developments
- Keep responses focused on what was asked (synopsis, recommendations, current status)
- If multiple matches exist, present the most popular/relevant one with a brief note
- When the query is vague, ask one clarifying question before proceeding
- If a tool returns an Error/Failed result, report that failure instead of treating it as success"""


def _extract_direct_rating_update(query: str) -> dict[str, Any] | None:
    media_id_match = re.search(r"(?:media\s*id|id)\s*[:#-]?\s*(\d+)", query, re.IGNORECASE)
    if not media_id_match:
        return None

    score_match = re.search(r"(\d+(?:\.\d+)?)\s*/\s*10", query, re.IGNORECASE) or re.search(
        r"(?:score|rating)\s*(?:to|=)?\s*(\d+(?:\.\d+)?)", query, re.IGNORECASE
    )
    if not score_match:
        return None

    media_id = int(media_id_match.group(1))
    score = float(score_match.group(1))

    upper = query.upper()
    status = next((value for value in STATUS_VALUES if value in upper), None)
    progress_match = re.search(r"(?:progress|watched|read)\s*(?:to|=)?\s*(\d+)", query, re.IGNORECASE)
    progress = int(progress_match.group(1)) if progress_match else None

    return {"mediaId": media_id, "score": score, "status": status, "progress": progress}


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(anilist_tools)


class AniListArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language query for anime or manga info (e.g., 'What's the rating of "
            "Attack on Titan?', 'How many episodes of JJK are out?', 'Update my rating for "
            "One Piece to 9/10')"
        )
    )


@tool("anilist", args_schema=AniListArgs)
async def anilist_tool(query: str) -> str:
    """Search anime/manga and manage authenticated AniList list actions, including rating updates, status changes, and progress updates."""
    direct_update = _extract_direct_rating_update(query)
    if direct_update and current_execution() is None:
        result = await add_list_entry.ainvoke(
            {
                "mediaId": direct_update["mediaId"],
                "score": direct_update["score"],
                "status": direct_update["status"],
                "progress": direct_update["progress"],
            }
        )
        status_note = f" Status: {direct_update['status']}." if direct_update["status"] else ""
        result_text = result if isinstance(result, str) else dumps(result)
        return (
            f"Updated your AniList entry (mediaId {direct_update['mediaId']}) to "
            f"{direct_update['score']}/10.{status_note}\n{result_text}"
        )

    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": ANILIST_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "anilist",
    )
