from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field, model_validator

from app.config import get_settings
from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("anilist")

ANILIST_URL = "https://graphql.anilist.co"
MAX_PER_PAGE = 25

MediaType = Literal["ANIME", "MANGA"]
MediaListStatus = Literal["CURRENT", "PLANNING", "COMPLETED", "DROPPED", "PAUSED", "REPEATING"]
MediaSeason = Literal["WINTER", "SPRING", "SUMMER", "FALL"]
MediaSort = Literal[
    "POPULARITY_DESC", "SCORE_DESC", "TRENDING_DESC", "START_DATE_DESC", "FAVOURITES_DESC", "SEARCH_MATCH"
]
MediaStatus = Literal["FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"]


class FuzzyDate(BaseModel):
    year: int | None = None
    month: int | None = None
    day: int | None = None


async def _anilist_token() -> str | None:
    db_token = await get_valid_token("anilist")
    if db_token:
        return db_token
    return get_settings().ANILIST_TOKEN


def _clean_variables(variables: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in variables.items() if value is not None}


async def _gql(query: str, variables: dict[str, Any] | None = None, require_auth: bool = False) -> dict[str, Any]:
    headers: dict[str, str] = {"Content-Type": "application/json", "Accept": "application/json"}

    token = await _anilist_token()
    if require_auth and not token:
        raise RuntimeError("AniList is not connected. Please connect AniList in Connections first.")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    response = await get_client().post(
        ANILIST_URL, headers=headers, json={"query": query, "variables": _clean_variables(variables or {})}
    )
    text = response.text
    try:
        body = response.json() if text else {}
    except ValueError:
        raise RuntimeError(f"AniList API {response.status_code}: {text}") from None

    errors = body.get("errors") or []
    if response.is_error or errors:
        message = "; ".join(e.get("message") for e in errors if e.get("message")) or f"AniList API {response.status_code}"
        raise RuntimeError(message)

    if not body.get("data"):
        raise RuntimeError("AniList returned no data.")
    return body["data"]


def _per_page(value: float | None, fallback: int = 5) -> int:
    if not value:
        return fallback
    return min(max(int(value), 1), MAX_PER_PAGE)


def _page(value: float | None) -> int:
    if not value:
        return 1
    return max(int(value), 1)


def _year_start(year: int | None) -> int | None:
    return int(f"{year}0101") if year else None


def _year_end(year: int | None) -> int | None:
    return int(f"{year}1231") if year else None


def _date_input(value: FuzzyDate | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if value.year is None and value.month is None and value.day is None:
        return None
    return value.model_dump(exclude_none=True)


def _sort_list(sort: str | None, fallback: str) -> list[str]:
    return [sort or fallback]


async def _authenticated_username() -> str:
    data = await _gql("query { Viewer { name } }", require_auth=True)
    return data["Viewer"]["name"]


MEDIA_FIELDS = """
  id
  idMal
  title { romaji english native userPreferred }
  type
  format
  status
  description(asHtml: false)
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  episodes
  duration
  chapters
  volumes
  source
  countryOfOrigin
  averageScore
  meanScore
  popularity
  trending
  favourites
  genres
  synonyms
  tags { id name rank category isGeneralSpoiler isMediaSpoiler isAdult }
  coverImage { large extraLarge color }
  bannerImage
  siteUrl
  nextAiringEpisode { id episode airingAt timeUntilAiring }
  studios(isMain: true) { nodes { id name isAnimationStudio siteUrl } }
  mediaListEntry {
    id status score(format: POINT_10_DECIMAL) progress progressVolumes
    repeat priority private notes startedAt { year month day }
    completedAt { year month day } updatedAt
  }
"""


class SearchAnimeArgs(BaseModel):
    query: str | None = Field(default=None, description="Search query")
    perPage: int | None = Field(default=None, description="Number of results, max 25")
    page: int | None = Field(default=None, description="Result page, default 1")
    year: int | None = Field(default=None, description="Season year, e.g. 2024")
    season: MediaSeason | None = Field(default=None, description="Release season")
    genre: str | None = Field(default=None, description='Genre filter, e.g. "Action"')
    tag: str | None = Field(default=None, description='Tag filter, e.g. "Time Manipulation"')


@tool("search_anime", args_schema=SearchAnimeArgs)
async def search_anime(
    query: str | None = None,
    perPage: int | None = None,
    page: int | None = None,
    year: int | None = None,
    season: MediaSeason | None = None,
    genre: str | None = None,
    tag: str | None = None,
) -> str:
    """Search for anime on AniList by title/keyword, optionally filtered by year, season, genre, or tag."""
    try:
        data = await _gql(
            f"""query($search: String, $page: Int, $perPage: Int, $seasonYear: Int, $season: MediaSeason, $genre: String, $tag: String) {{
              Page(page: $page, perPage: $perPage) {{
                pageInfo {{ total currentPage lastPage hasNextPage }}
                media(search: $search, type: ANIME, sort: [POPULARITY_DESC], seasonYear: $seasonYear, season: $season, genre: $genre, tag: $tag, isAdult: false) {{
                  {MEDIA_FIELDS}
                }}
              }}
            }}""",
            {
                "search": query,
                "page": _page(page),
                "perPage": _per_page(perPage),
                "seasonYear": year,
                "season": season,
                "genre": genre,
                "tag": tag,
            },
        )
        return dumps(data["Page"])
    except Exception as exc:
        logger.error("[anilist] searchAnime", exc_info=exc)
        return f"Error searching anime: {exc}"


class SearchMangaArgs(BaseModel):
    query: str | None = Field(default=None, description="Search query")
    perPage: int | None = Field(default=None, description="Number of results, max 25")
    page: int | None = Field(default=None, description="Result page, default 1")
    year: int | None = Field(default=None, description="Start year, e.g. 2020")
    genre: str | None = Field(default=None, description='Genre filter, e.g. "Action"')
    tag: str | None = Field(default=None, description='Tag filter, e.g. "Isekai"')


@tool("search_manga", args_schema=SearchMangaArgs)
async def search_manga(
    query: str | None = None,
    perPage: int | None = None,
    page: int | None = None,
    year: int | None = None,
    genre: str | None = None,
    tag: str | None = None,
) -> str:
    """Search for manga on AniList by title/keyword, optionally filtered by start year, genre, or tag."""
    try:
        data = await _gql(
            f"""query($search: String, $page: Int, $perPage: Int, $startGreater: FuzzyDateInt, $startLesser: FuzzyDateInt, $genre: String, $tag: String) {{
              Page(page: $page, perPage: $perPage) {{
                pageInfo {{ total currentPage lastPage hasNextPage }}
                media(search: $search, type: MANGA, sort: [POPULARITY_DESC], startDate_greater: $startGreater, startDate_lesser: $startLesser, genre: $genre, tag: $tag, isAdult: false) {{
                  {MEDIA_FIELDS}
                }}
              }}
            }}""",
            {
                "search": query,
                "page": _page(page),
                "perPage": _per_page(perPage),
                "startGreater": _year_start(year),
                "startLesser": _year_end(year),
                "genre": genre,
                "tag": tag,
            },
        )
        return dumps(data["Page"])
    except Exception as exc:
        logger.error("[anilist] searchManga", exc_info=exc)
        return f"Error searching manga: {exc}"


class DiscoverMediaArgs(BaseModel):
    type: MediaType = Field(description="ANIME or MANGA")
    query: str | None = Field(default=None, description="Optional title/keyword search")
    perPage: int | None = Field(default=None, description="Number of results, max 25")
    page: int | None = Field(default=None, description="Result page, default 1")
    sort: MediaSort | None = Field(default=None, description="Sort order")
    year: int | None = Field(default=None, description="Season year for anime")
    season: MediaSeason | None = Field(default=None, description="Anime release season")
    status: MediaStatus | None = None
    genre: str | None = None
    tag: str | None = None
    onList: bool | None = Field(default=None, description="Filter by authenticated user list membership")


@tool("discover_media", args_schema=DiscoverMediaArgs)
async def discover_media(
    type: MediaType,
    query: str | None = None,
    perPage: int | None = None,
    page: int | None = None,
    sort: MediaSort | None = None,
    year: int | None = None,
    season: MediaSeason | None = None,
    status: MediaStatus | None = None,
    genre: str | None = None,
    tag: str | None = None,
    onList: bool | None = None,
) -> str:
    """Discover anime or manga using AniList filters such as trending, score, popularity, year, season, status, genre, tag, and whether it is on the authenticated user list."""
    try:
        data = await _gql(
            f"""query($type: MediaType, $search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $seasonYear: Int, $season: MediaSeason, $status: MediaStatus, $genre: String, $tag: String, $onList: Boolean) {{
              Page(page: $page, perPage: $perPage) {{
                pageInfo {{ total currentPage lastPage hasNextPage }}
                media(type: $type, search: $search, sort: $sort, seasonYear: $seasonYear, season: $season, status: $status, genre: $genre, tag: $tag, onList: $onList, isAdult: false) {{
                  {MEDIA_FIELDS}
                }}
              }}
            }}""",
            {
                "type": type,
                "search": query,
                "page": _page(page),
                "perPage": _per_page(perPage, 10),
                "sort": _sort_list(sort, "SEARCH_MATCH" if query else "TRENDING_DESC"),
                "seasonYear": year,
                "season": season,
                "status": status,
                "genre": genre,
                "tag": tag,
                "onList": onList,
            },
            require_auth=onList is not None,
        )
        return dumps(data["Page"])
    except Exception as exc:
        logger.error("[anilist] discoverMedia", exc_info=exc)
        return f"Error discovering media: {exc}"


@tool("get_anilist_genres_and_tags")
async def get_genres_and_tags() -> str:
    """Get AniList genre and tag metadata for helping with search and recommendations."""
    try:
        data = await _gql(
            """query {
              GenreCollection
              MediaTagCollection {
                id name description category rank isGeneralSpoiler isMediaSpoiler isAdult
              }
            }"""
        )
        return dumps(data)
    except Exception as exc:
        logger.error("[anilist] getGenresAndTags", exc_info=exc)
        return f"Error fetching AniList genres/tags: {exc}"


class MediaLookupArgs(BaseModel):
    id: int | None = Field(default=None, description="AniList media ID")
    idMal: int | None = Field(default=None, description="MyAnimeList media ID")

    @model_validator(mode="after")
    def _require_one(self) -> MediaLookupArgs:
        if self.id is None and self.idMal is None:
            raise ValueError("Provide either id or idMal.")
        return self


@tool("get_anime", args_schema=MediaLookupArgs)
async def get_anime(id: int | None = None, idMal: int | None = None) -> str:
    """Get detailed info about an anime by AniList ID or MAL ID."""
    try:
        data = await _gql(
            f"""query($id: Int, $idMal: Int) {{
              Media(id: $id, idMal: $idMal, type: ANIME) {{
                {MEDIA_FIELDS}
                relations {{
                  edges {{
                    relationType
                    node {{ id title {{ romaji english userPreferred }} type format status siteUrl }}
                  }}
                }}
                characters(page: 1, perPage: 10, sort: [ROLE, RELEVANCE, ID]) {{
                  edges {{
                    role
                    node {{ id name {{ full native userPreferred }} siteUrl }}
                    voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) {{
                      id name {{ full userPreferred }} languageV2 siteUrl
                    }}
                  }}
                }}
                externalLinks {{ id site url type language color icon }}
                streamingEpisodes {{ title thumbnail url site }}
              }}
            }}""",
            {"id": id, "idMal": idMal},
        )
        return dumps(data["Media"])
    except Exception as exc:
        logger.error("[anilist] getAnime", exc_info=exc)
        return f"Error fetching anime: {exc}"


@tool("get_manga", args_schema=MediaLookupArgs)
async def get_manga(id: int | None = None, idMal: int | None = None) -> str:
    """Get detailed info about a manga by AniList ID or MAL ID."""
    try:
        data = await _gql(
            f"""query($id: Int, $idMal: Int) {{
              Media(id: $id, idMal: $idMal, type: MANGA) {{
                {MEDIA_FIELDS}
                relations {{
                  edges {{
                    relationType
                    node {{ id title {{ romaji english userPreferred }} type format status siteUrl }}
                  }}
                }}
                characters(page: 1, perPage: 10, sort: [ROLE, RELEVANCE, ID]) {{
                  edges {{
                    role
                    node {{ id name {{ full native userPreferred }} siteUrl }}
                  }}
                }}
                externalLinks {{ id site url type language color icon }}
              }}
            }}""",
            {"id": id, "idMal": idMal},
        )
        return dumps(data["Media"])
    except Exception as exc:
        logger.error("[anilist] getManga", exc_info=exc)
        return f"Error fetching manga: {exc}"


class GetAiringScheduleArgs(BaseModel):
    mediaId: int | None = Field(default=None, description="AniList anime media ID")
    daysAhead: int | None = Field(default=None, description="How many days ahead to search")
    perPage: int | None = Field(default=None, description="Number of results, max 25")


@tool("get_airing_schedule", args_schema=GetAiringScheduleArgs)
async def get_airing_schedule(
    mediaId: int | None = None, daysAhead: int | None = None, perPage: int | None = None
) -> str:
    """Get upcoming AniList airing episodes, optionally for a specific anime media ID."""
    try:
        now = int(dt.datetime.now(dt.UTC).timestamp())
        end = now + (daysAhead or 14) * 24 * 60 * 60
        data = await _gql(
            """query($mediaId: Int, $airingAtGreater: Int, $airingAtLesser: Int, $perPage: Int) {
              Page(page: 1, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage }
                airingSchedules(mediaId: $mediaId, airingAt_greater: $airingAtGreater, airingAt_lesser: $airingAtLesser, sort: [TIME]) {
                  id airingAt timeUntilAiring episode mediaId
                  media { id title { romaji english userPreferred } type format status episodes coverImage { medium } siteUrl }
                }
              }
            }""",
            {
                "mediaId": mediaId,
                "airingAtGreater": now,
                "airingAtLesser": end,
                "perPage": _per_page(perPage, 10),
            },
        )
        return dumps(data["Page"])
    except Exception as exc:
        logger.error("[anilist] getAiringSchedule", exc_info=exc)
        return f"Error fetching airing schedule: {exc}"


class SearchCharactersArgs(BaseModel):
    query: str = Field(description="Character name search")
    perPage: int | None = Field(default=None, description="Number of results, max 25")


@tool("search_anilist_characters", args_schema=SearchCharactersArgs)
async def search_characters(query: str, perPage: int | None = None) -> str:
    """Search AniList characters by name."""
    try:
        data = await _gql(
            """query($search: String, $perPage: Int) {
              Page(page: 1, perPage: $perPage) {
                characters(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
                  id name { full native userPreferred } image { large } gender age favourites siteUrl
                  media(page: 1, perPage: 5, sort: [POPULARITY_DESC]) {
                    nodes { id title { romaji english userPreferred } type format siteUrl }
                  }
                }
              }
            }""",
            {"search": query, "perPage": _per_page(perPage)},
        )
        return dumps(data["Page"]["characters"])
    except Exception as exc:
        logger.error("[anilist] searchCharacters", exc_info=exc)
        return f"Error searching characters: {exc}"


class SearchStaffArgs(BaseModel):
    query: str = Field(description="Staff or voice actor name search")
    perPage: int | None = Field(default=None, description="Number of results, max 25")


@tool("search_anilist_staff", args_schema=SearchStaffArgs)
async def search_staff(query: str, perPage: int | None = None) -> str:
    """Search AniList staff or voice actors by name."""
    try:
        data = await _gql(
            """query($search: String, $perPage: Int) {
              Page(page: 1, perPage: $perPage) {
                staff(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
                  id name { full native userPreferred } languageV2 image { large }
                  primaryOccupations age yearsActive homeTown favourites siteUrl
                  staffMedia(page: 1, perPage: 5, sort: [POPULARITY_DESC]) {
                    nodes { id title { romaji english userPreferred } type format siteUrl }
                  }
                }
              }
            }""",
            {"search": query, "perPage": _per_page(perPage)},
        )
        return dumps(data["Page"]["staff"])
    except Exception as exc:
        logger.error("[anilist] searchStaff", exc_info=exc)
        return f"Error searching staff: {exc}"


class SearchStudiosArgs(BaseModel):
    query: str = Field(description="Studio name search")
    perPage: int | None = Field(default=None, description="Number of results, max 25")


@tool("search_anilist_studios", args_schema=SearchStudiosArgs)
async def search_studios(query: str, perPage: int | None = None) -> str:
    """Search AniList studios by name."""
    try:
        data = await _gql(
            """query($search: String, $perPage: Int) {
              Page(page: 1, perPage: $perPage) {
                studios(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
                  id name isAnimationStudio favourites siteUrl
                  media(page: 1, perPage: 5, sort: [POPULARITY_DESC], isMain: true) {
                    nodes { id title { romaji english userPreferred } type format averageScore siteUrl }
                  }
                }
              }
            }""",
            {"search": query, "perPage": _per_page(perPage)},
        )
        return dumps(data["Page"]["studios"])
    except Exception as exc:
        logger.error("[anilist] searchStudios", exc_info=exc)
        return f"Error searching studios: {exc}"


@tool("get_anilist_viewer")
async def get_viewer() -> str:
    """Get the authenticated AniList account profile, settings, score format, custom lists, and stats."""
    try:
        data = await _gql(
            """query {
              Viewer {
                id name about avatar { large } bannerImage siteUrl
                options { titleLanguage displayAdultContent airingNotifications profileColor timezone }
                mediaListOptions { scoreFormat rowOrder animeList { sectionOrder customLists advancedScoring advancedScoringEnabled } mangaList { sectionOrder customLists advancedScoring advancedScoringEnabled } }
                statistics {
                  anime { count episodesWatched minutesWatched meanScore statuses { status count } genres { genre count meanScore } }
                  manga { count chaptersRead volumesRead meanScore statuses { status count } genres { genre count meanScore } }
                }
              }
            }""",
            require_auth=True,
        )
        return dumps(data["Viewer"])
    except Exception as exc:
        logger.error("[anilist] getViewer", exc_info=exc)
        return f"Error fetching authenticated AniList viewer: {exc}"


class GetUserAnimeListArgs(BaseModel):
    userName: str | None = Field(default=None, description="AniList username")
    status: MediaListStatus | None = None


@tool("get_user_anime_list", args_schema=GetUserAnimeListArgs)
async def get_user_anime_list(userName: str | None = None, status: MediaListStatus | None = None) -> str:
    """Get a user's AniList anime list, including list entry IDs for updates/deletes. If userName is omitted, uses the authenticated account."""
    try:
        target_username = userName or await _authenticated_username()
        data = await _gql(
            """query($userName: String, $status: MediaListStatus) {
              MediaListCollection(userName: $userName, type: ANIME, status: $status) {
                lists {
                  name isCustomList isSplitCompletedList status
                  entries {
                    id mediaId status
                    myRating: score(format: POINT_10_DECIMAL)
                    myRating100: score(format: POINT_100)
                    progress progressVolumes repeat priority private notes updatedAt
                    startedAt { year month day } completedAt { year month day }
                    media { id title { romaji english userPreferred } episodes status format averageScore siteUrl coverImage { medium } }
                  }
                }
              }
            }""",
            {"userName": target_username, "status": status},
            require_auth=not userName,
        )
        return dumps(data["MediaListCollection"])
    except Exception as exc:
        logger.error("[anilist] getUserAnimeList", exc_info=exc)
        return f"Error fetching anime list: {exc}"


class GetUserMangaListArgs(BaseModel):
    userName: str | None = Field(default=None, description="AniList username")
    status: MediaListStatus | None = None


@tool("get_user_manga_list", args_schema=GetUserMangaListArgs)
async def get_user_manga_list(userName: str | None = None, status: MediaListStatus | None = None) -> str:
    """Get a user's AniList manga list, including list entry IDs for updates/deletes. If userName is omitted, uses the authenticated account."""
    try:
        target_username = userName or await _authenticated_username()
        data = await _gql(
            """query($userName: String, $status: MediaListStatus) {
              MediaListCollection(userName: $userName, type: MANGA, status: $status) {
                lists {
                  name isCustomList isSplitCompletedList status
                  entries {
                    id mediaId status
                    myRating: score(format: POINT_10_DECIMAL)
                    myRating100: score(format: POINT_100)
                    progress progressVolumes repeat priority private notes updatedAt
                    startedAt { year month day } completedAt { year month day }
                    media { id title { romaji english userPreferred } chapters volumes status format averageScore siteUrl coverImage { medium } }
                  }
                }
              }
            }""",
            {"userName": target_username, "status": status},
            require_auth=not userName,
        )
        return dumps(data["MediaListCollection"])
    except Exception as exc:
        logger.error("[anilist] getUserMangaList", exc_info=exc)
        return f"Error fetching manga list: {exc}"


class GetMediaListEntryArgs(BaseModel):
    mediaId: int = Field(description="AniList media ID")
    userName: str | None = Field(default=None, description="AniList username")


@tool("get_media_list_entry", args_schema=GetMediaListEntryArgs)
async def get_media_list_entry(mediaId: int, userName: str | None = None) -> str:
    """Get one AniList list entry by media ID and optional username. Use this before updating or deleting when only mediaId/title is known."""
    try:
        target_username = userName or await _authenticated_username()
        data = await _gql(
            """query($mediaId: Int, $userName: String) {
              MediaList(mediaId: $mediaId, userName: $userName) {
                id mediaId status score(format: POINT_10_DECIMAL) progress progressVolumes
                repeat priority private notes hiddenFromStatusLists customLists advancedScores
                startedAt { year month day } completedAt { year month day }
                createdAt updatedAt
                media { id title { romaji english userPreferred } type format status episodes chapters volumes siteUrl }
              }
            }""",
            {"mediaId": mediaId, "userName": target_username},
            require_auth=not userName,
        )
        return dumps(data["MediaList"])
    except Exception as exc:
        logger.error("[anilist] getMediaListEntry", exc_info=exc)
        return f"Error fetching media list entry: {exc}"


class ListMutationArgs(BaseModel):
    mediaId: int | None = Field(default=None, description="AniList media ID")
    entryId: int | None = Field(default=None, description="AniList media list entry ID")
    status: MediaListStatus | None = None
    score: float | None = Field(default=None, description="Score in the user score format")
    scoreRaw: int | None = Field(default=None, description="Raw score value for advanced formats")
    progress: int | None = Field(default=None, description="Episodes/chapters watched/read")
    progressVolumes: int | None = Field(default=None, description="Manga volumes read")
    repeat: int | None = Field(default=None, description="Rewatch/reread count")
    priority: int | None = Field(default=None, description="Priority number")
    private: bool | None = Field(default=None, description="Whether this list entry is private")
    notes: str | None = Field(default=None, description="Private notes for the list entry")
    hiddenFromStatusLists: bool | None = None
    startedAt: FuzzyDate | None = None
    completedAt: FuzzyDate | None = None

    @model_validator(mode="after")
    def _require_one(self) -> ListMutationArgs:
        if self.mediaId is None and self.entryId is None:
            raise ValueError("Provide either mediaId or entryId.")
        return self


async def _save_media_list_entry(args: ListMutationArgs) -> str:
    data = await _gql(
        """mutation($id: Int, $mediaId: Int, $status: MediaListStatus, $score: Float, $scoreRaw: Int, $progress: Int, $progressVolumes: Int, $repeat: Int, $priority: Int, $private: Boolean, $notes: String, $hiddenFromStatusLists: Boolean, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
          SaveMediaListEntry(id: $id, mediaId: $mediaId, status: $status, score: $score, scoreRaw: $scoreRaw, progress: $progress, progressVolumes: $progressVolumes, repeat: $repeat, priority: $priority, private: $private, notes: $notes, hiddenFromStatusLists: $hiddenFromStatusLists, startedAt: $startedAt, completedAt: $completedAt) {
            id mediaId status score(format: POINT_10_DECIMAL) progress progressVolumes repeat priority private notes hiddenFromStatusLists updatedAt
            startedAt { year month day } completedAt { year month day }
            media { id title { romaji english userPreferred } type format siteUrl }
          }
        }""",
        {
            "id": args.entryId,
            "mediaId": args.mediaId,
            "status": args.status,
            "score": args.score,
            "scoreRaw": args.scoreRaw,
            "progress": args.progress,
            "progressVolumes": args.progressVolumes,
            "repeat": args.repeat,
            "priority": args.priority,
            "private": args.private,
            "notes": args.notes,
            "hiddenFromStatusLists": args.hiddenFromStatusLists,
            "startedAt": _date_input(args.startedAt),
            "completedAt": _date_input(args.completedAt),
        },
        require_auth=True,
    )
    return dumps(data["SaveMediaListEntry"])


@tool("add_list_entry", args_schema=ListMutationArgs)
async def add_list_entry(**kwargs: Any) -> str:
    """Add or update an anime/manga entry in the authenticated user's AniList by mediaId or existing entryId."""
    try:
        return await _save_media_list_entry(ListMutationArgs(**kwargs))
    except Exception as exc:
        logger.error("[anilist] addListEntry", exc_info=exc)
        return f"Error saving list entry: {exc}"


@tool("update_list_entry", args_schema=ListMutationArgs)
async def update_list_entry(**kwargs: Any) -> str:
    """Update an existing AniList list entry. entryId is preferred; mediaId also works through SaveMediaListEntry."""
    try:
        return await _save_media_list_entry(ListMutationArgs(**kwargs))
    except Exception as exc:
        logger.error("[anilist] updateListEntry", exc_info=exc)
        return f"Error saving list entry: {exc}"


class RemoveListEntryArgs(BaseModel):
    entryId: int = Field(description="AniList media list entry ID")


@tool("remove_list_entry", args_schema=RemoveListEntryArgs)
async def remove_list_entry(entryId: int) -> str:
    """Remove an entry from the authenticated user's AniList by media list entry ID. Ask for confirmation before using."""
    try:
        data = await _gql(
            "mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }",
            {"id": entryId},
            require_auth=True,
        )
        return "Entry deleted." if data["DeleteMediaListEntry"]["deleted"] else "Entry not found."
    except Exception as exc:
        logger.error("[anilist] removeListEntry", exc_info=exc)
        return f"Error removing list entry: {exc}"


FavouriteType = Literal["ANIME", "MANGA", "CHARACTER", "STAFF", "STUDIO"]


class ToggleFavouriteArgs(BaseModel):
    type: FavouriteType
    id: int = Field(description="AniList ID for the selected type")


@tool("toggle_anilist_favourite", args_schema=ToggleFavouriteArgs)
async def toggle_favourite(type: FavouriteType, id: int) -> str:
    """Toggle favourite status for anime, manga, character, staff, or studio. Ask for confirmation before using."""
    try:
        variables = {
            "animeId": id if type == "ANIME" else None,
            "mangaId": id if type == "MANGA" else None,
            "characterId": id if type == "CHARACTER" else None,
            "staffId": id if type == "STAFF" else None,
            "studioId": id if type == "STUDIO" else None,
        }
        data = await _gql(
            """mutation($animeId: Int, $mangaId: Int, $characterId: Int, $staffId: Int, $studioId: Int) {
              ToggleFavourite(animeId: $animeId, mangaId: $mangaId, characterId: $characterId, staffId: $staffId, studioId: $studioId) {
                anime { nodes { id title { userPreferred } isFavourite } }
                manga { nodes { id title { userPreferred } isFavourite } }
                characters { nodes { id name { userPreferred } isFavourite } }
                staff { nodes { id name { userPreferred } isFavourite } }
                studios { nodes { id name isFavourite } }
              }
            }""",
            variables,
            require_auth=True,
        )
        return dumps(data["ToggleFavourite"])
    except Exception as exc:
        logger.error("[anilist] toggleFavourite", exc_info=exc)
        return f"Error toggling favourite: {exc}"


class GetUserProfileArgs(BaseModel):
    userName: str | None = Field(default=None, description="AniList username")


@tool("get_user_profile", args_schema=GetUserProfileArgs)
async def get_user_profile(userName: str | None = None) -> str:
    """Get an AniList user's profile and watch/read statistics. If userName is omitted, gets the authenticated viewer."""
    try:
        if not userName:
            return await get_viewer.ainvoke({})

        data = await _gql(
            """query($name: String) {
              User(name: $name) {
                id name about avatar { large } bannerImage siteUrl
                statistics {
                  anime { count episodesWatched minutesWatched meanScore statuses { status count } genres { genre count meanScore } }
                  manga { count chaptersRead volumesRead meanScore statuses { status count } genres { genre count meanScore } }
                }
              }
            }""",
            {"name": userName},
        )
        return dumps(data["User"])
    except Exception as exc:
        logger.error("[anilist] getUserProfile", exc_info=exc)
        return f"Error fetching profile: {exc}"


class GetRecommendationsArgs(BaseModel):
    mediaId: int = Field(description="AniList media ID")
    perPage: int | None = Field(default=None, description="Number of recommendations, max 25")


@tool("get_recommendations_for_media", args_schema=GetRecommendationsArgs)
async def get_recommendations(mediaId: int, perPage: int | None = None) -> str:
    """Get community recommendations for a given anime or manga by AniList ID."""
    try:
        data = await _gql(
            """query($id: Int, $perPage: Int) {
              Media(id: $id) {
                id title { romaji english userPreferred }
                recommendations(sort: RATING_DESC, page: 1, perPage: $perPage) {
                  nodes {
                    id rating userRating
                    mediaRecommendation {
                      id title { romaji english userPreferred } type format status averageScore
                      description(asHtml: false) coverImage { medium } siteUrl
                    }
                  }
                }
              }
            }""",
            {"id": mediaId, "perPage": _per_page(perPage, 10)},
        )
        return dumps(data["Media"])
    except Exception as exc:
        logger.error("[anilist] getRecommendations", exc_info=exc)
        return f"Error fetching recommendations: {exc}"


anilist_tools = [
    search_anime,
    search_manga,
    discover_media,
    get_genres_and_tags,
    get_anime,
    get_manga,
    get_airing_schedule,
    search_characters,
    search_staff,
    search_studios,
    get_viewer,
    get_user_anime_list,
    get_user_manga_list,
    get_media_list_entry,
    add_list_entry,
    update_list_entry,
    remove_list_entry,
    toggle_favourite,
    get_user_profile,
    get_recommendations,
]
