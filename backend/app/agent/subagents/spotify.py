from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.spotify import spotify_tools

SPOTIFY_SYSTEM_PROMPT = """You are a Spotify Assistant with access to the user's Spotify account.

You can:
- Read current playback, devices, recently played tracks, playlists, and playlist tracks
- Search for tracks, artists, albums, and playlists
- Start, pause, skip, set volume, and add items to the queue

When helping:
- Always use real Spotify data from tools; never invent track, artist, playlist, or device details
- Resolve track/album/playlist names to Spotify URIs before playback or queue actions
- If playback fails because there is no active device, list available devices and explain that Spotify needs an active device
- Keep responses concise and include track/artist names when reporting playback changes
- If a tool returns an Error/Failed result, report that failure instead of treating it as success"""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(spotify_tools)


class SpotifyArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language Spotify request (e.g., 'What is playing?', 'Play Blinding "
            "Lights', 'Add this track to queue', 'Show my recent songs')"
        )
    )


@tool("spotify", args_schema=SpotifyArgs)
async def spotify_tool(query: str) -> str:
    """Spotify access — search music, inspect playback/devices/playlists/recent listening, and control playback."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": SPOTIFY_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "spotify",
    )
