from __future__ import annotations

from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("spotify")

SPOTIFY_API_URL = "https://api.spotify.com/v1"


async def _token() -> str:
    token = await get_valid_token("spotify")
    if not token:
        raise RuntimeError("Spotify is not connected. Please connect Spotify in Connections first.")
    return token


async def _spotify_fetch(
    path: str,
    method: str = "GET",
    body: Any = None,
    query: dict[str, Any] | None = None,
) -> Any:
    token = await _token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"

    params = {k: v for k, v in (query or {}).items() if v is not None}
    response = await get_client().request(
        method, f"{SPOTIFY_API_URL}{path}", params=params, headers=headers, json=body
    )
    if response.status_code == 204:
        return None

    text = response.text
    data = response.json() if text else None

    if response.is_error:
        message = dumps(data["error"]) if isinstance(data, dict) and "error" in data else text
        raise RuntimeError(f"Spotify API request failed ({response.status_code}): {message}")

    return data


def _summarize_track(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return item
    album = item.get("album") or {}
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "artists": [a.get("name") for a in item.get("artists") or [] if a.get("name")],
        "album": album.get("name"),
        "releaseDate": album.get("release_date"),
        "durationMs": item.get("duration_ms"),
        "popularity": item.get("popularity"),
        "uri": item.get("uri"),
        "url": (item.get("external_urls") or {}).get("spotify"),
    }


def _summarize_artist(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return item
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "genres": item.get("genres"),
        "popularity": item.get("popularity"),
        "uri": item.get("uri"),
        "url": (item.get("external_urls") or {}).get("spotify"),
    }


def _summarize_album(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return item
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "artists": [a.get("name") for a in item.get("artists") or [] if a.get("name")],
        "releaseDate": item.get("release_date"),
        "totalTracks": item.get("total_tracks"),
        "uri": item.get("uri"),
        "url": (item.get("external_urls") or {}).get("spotify"),
    }


@tool("spotify_get_profile")
async def spotify_get_profile() -> str:
    """Get the authenticated Spotify user profile."""
    try:
        return dumps(await _spotify_fetch("/me"))
    except Exception as exc:
        logger.error("[spotify] getSpotifyProfile", exc_info=exc)
        return f"Error fetching Spotify profile: {exc}"


SpotifyItemType = Literal["track", "artist", "album", "playlist"]


class SearchSpotifyArgs(BaseModel):
    query: str = Field(description="Spotify search query")
    type: list[SpotifyItemType] = Field(default=["track"], description="Item types to search for")
    limit: int | None = Field(default=None, description="Result limit")


@tool("spotify_search", args_schema=SearchSpotifyArgs)
async def search_spotify(query: str, type: list[SpotifyItemType] = ["track"], limit: int | None = None) -> str:  # noqa: B006
    """Search Spotify for tracks, artists, albums, or playlists."""
    try:
        data = await _spotify_fetch(
            "/search", query={"q": query, "type": ",".join(type), "limit": limit or 5}
        )
        data = data or {}
        return dumps(
            {
                "tracks": [_summarize_track(t) for t in (data.get("tracks") or {}).get("items", [])] if data.get("tracks") else None,
                "artists": [_summarize_artist(a) for a in (data.get("artists") or {}).get("items", [])] if data.get("artists") else None,
                "albums": [_summarize_album(a) for a in (data.get("albums") or {}).get("items", [])] if data.get("albums") else None,
                "playlists": (data.get("playlists") or {}).get("items") if data.get("playlists") else None,
            }
        )
    except Exception as exc:
        logger.error("[spotify] searchSpotify", exc_info=exc)
        return f"Error searching Spotify: {exc}"


@tool("spotify_get_current_playback")
async def get_current_playback() -> str:
    """Get the current Spotify playback state and playing track."""
    try:
        data = await _spotify_fetch("/me/player")
        if not data:
            return "No active Spotify playback."
        return dumps(
            {
                "isPlaying": data.get("is_playing"),
                "progressMs": data.get("progress_ms"),
                "device": data.get("device"),
                "track": _summarize_track(data.get("item")),
                "context": data.get("context"),
            }
        )
    except Exception as exc:
        logger.error("[spotify] getCurrentPlayback", exc_info=exc)
        return f"Error fetching Spotify playback: {exc}"


@tool("spotify_get_available_devices")
async def get_available_devices() -> str:
    """List Spotify Connect devices available for playback."""
    try:
        data = await _spotify_fetch("/me/player/devices")
        return dumps((data or {}).get("devices") or [])
    except Exception as exc:
        logger.error("[spotify] getAvailableDevices", exc_info=exc)
        return f"Error fetching Spotify devices: {exc}"


class GetRecentlyPlayedArgs(BaseModel):
    limit: int | None = Field(default=None, description="Result limit")


@tool("spotify_get_recently_played", args_schema=GetRecentlyPlayedArgs)
async def get_recently_played(limit: int | None = None) -> str:
    """Get recently played Spotify tracks."""
    try:
        data = await _spotify_fetch("/me/player/recently-played", query={"limit": limit or 10})
        items = (data or {}).get("items") or []
        return dumps(
            [{"playedAt": item.get("played_at"), "track": _summarize_track(item.get("track"))} for item in items]
        )
    except Exception as exc:
        logger.error("[spotify] getRecentlyPlayed", exc_info=exc)
        return f"Error fetching recently played tracks: {exc}"


class GetUserPlaylistsArgs(BaseModel):
    limit: int | None = Field(default=None, description="Result limit")


@tool("spotify_get_user_playlists", args_schema=GetUserPlaylistsArgs)
async def get_user_playlists(limit: int | None = None) -> str:
    """Get the authenticated user's Spotify playlists."""
    try:
        data = await _spotify_fetch("/me/playlists", query={"limit": limit or 20})
        return dumps((data or {}).get("items") or [])
    except Exception as exc:
        logger.error("[spotify] getUserPlaylists", exc_info=exc)
        return f"Error fetching Spotify playlists: {exc}"


class GetPlaylistTracksArgs(BaseModel):
    playlistId: str = Field(description="Spotify playlist ID")
    limit: int | None = Field(default=None, description="Result limit")


@tool("spotify_get_playlist_tracks", args_schema=GetPlaylistTracksArgs)
async def get_playlist_tracks(playlistId: str, limit: int | None = None) -> str:
    """Get tracks from a Spotify playlist by playlist ID."""
    try:
        data = await _spotify_fetch(f"/playlists/{playlistId}/tracks", query={"limit": limit or 50})
        items = (data or {}).get("items") or []
        return dumps([_summarize_track(item.get("track")) for item in items])
    except Exception as exc:
        logger.error("[spotify] getPlaylistTracks", exc_info=exc)
        return f"Error fetching Spotify playlist tracks: {exc}"


class StartOrResumePlaybackArgs(BaseModel):
    deviceId: str | None = Field(default=None, description="Spotify device ID")
    contextUri: str | None = Field(default=None, description="Spotify context URI, such as an album or playlist URI")
    uris: list[str] | None = Field(default=None, description="Spotify track URIs to play")
    positionMs: int | None = Field(default=None, description="Playback position in ms")


@tool("spotify_start_or_resume_playback", args_schema=StartOrResumePlaybackArgs)
async def start_or_resume_playback(
    deviceId: str | None = None,
    contextUri: str | None = None,
    uris: list[str] | None = None,
    positionMs: int | None = None,
) -> str:
    """Start or resume Spotify playback. Can play a context URI or a list of track URIs."""
    try:
        body: dict[str, Any] = {}
        if contextUri:
            body["context_uri"] = contextUri
        if uris:
            body["uris"] = uris
        if positionMs is not None:
            body["position_ms"] = positionMs

        await _spotify_fetch("/me/player/play", method="PUT", query={"device_id": deviceId}, body=body)
        return "Spotify playback started."
    except Exception as exc:
        logger.error("[spotify] startOrResumePlayback", exc_info=exc)
        return f"Error starting Spotify playback: {exc}"


class DeviceIdArgs(BaseModel):
    deviceId: str | None = Field(default=None, description="Spotify device ID")


@tool("spotify_pause_playback", args_schema=DeviceIdArgs)
async def pause_playback(deviceId: str | None = None) -> str:
    """Pause Spotify playback."""
    try:
        await _spotify_fetch("/me/player/pause", method="PUT", query={"device_id": deviceId})
        return "Spotify playback paused."
    except Exception as exc:
        logger.error("[spotify] pausePlayback", exc_info=exc)
        return f"Error pausing Spotify playback: {exc}"


@tool("spotify_skip_to_next", args_schema=DeviceIdArgs)
async def skip_to_next(deviceId: str | None = None) -> str:
    """Skip to the next Spotify track."""
    try:
        await _spotify_fetch("/me/player/next", method="POST", query={"device_id": deviceId})
        return "Skipped to the next Spotify track."
    except Exception as exc:
        logger.error("[spotify] skipToNext", exc_info=exc)
        return f"Error skipping Spotify track: {exc}"


@tool("spotify_skip_to_previous", args_schema=DeviceIdArgs)
async def skip_to_previous(deviceId: str | None = None) -> str:
    """Skip to the previous Spotify track."""
    try:
        await _spotify_fetch("/me/player/previous", method="POST", query={"device_id": deviceId})
        return "Skipped to the previous Spotify track."
    except Exception as exc:
        logger.error("[spotify] skipToPrevious", exc_info=exc)
        return f"Error going to previous Spotify track: {exc}"


class SetPlaybackVolumeArgs(BaseModel):
    volumePercent: int = Field(description="Volume percentage")
    deviceId: str | None = Field(default=None, description="Spotify device ID")


@tool("spotify_set_playback_volume", args_schema=SetPlaybackVolumeArgs)
async def set_playback_volume(volumePercent: int, deviceId: str | None = None) -> str:
    """Set Spotify playback volume from 0 to 100."""
    try:
        await _spotify_fetch(
            "/me/player/volume", method="PUT", query={"volume_percent": volumePercent, "device_id": deviceId}
        )
        return f"Spotify volume set to {volumePercent}%."
    except Exception as exc:
        logger.error("[spotify] setPlaybackVolume", exc_info=exc)
        return f"Error setting Spotify volume: {exc}"


class AddItemToQueueArgs(BaseModel):
    uri: str = Field(description="Spotify track or episode URI")
    deviceId: str | None = Field(default=None, description="Spotify device ID")


@tool("spotify_add_item_to_queue", args_schema=AddItemToQueueArgs)
async def add_item_to_queue(uri: str, deviceId: str | None = None) -> str:
    """Add a Spotify track or episode URI to the playback queue."""
    try:
        await _spotify_fetch("/me/player/queue", method="POST", query={"uri": uri, "device_id": deviceId})
        return f"Added {uri} to the Spotify queue."
    except Exception as exc:
        logger.error("[spotify] addItemToQueue", exc_info=exc)
        return f"Error adding item to Spotify queue: {exc}"


spotify_tools = [
    spotify_get_profile,
    search_spotify,
    get_current_playback,
    get_available_devices,
    get_recently_played,
    get_user_playlists,
    get_playlist_tracks,
    start_or_resume_playback,
    pause_playback,
    skip_to_next,
    skip_to_previous,
    set_playback_volume,
    add_item_to_queue,
]
