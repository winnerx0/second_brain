import { tool } from 'langchain';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getValidToken } from '../oauth.js';

const ANILIST_URL = 'https://graphql.anilist.co';
const MAX_PER_PAGE = 25;

const mediaTypeSchema = z.enum(['ANIME', 'MANGA']);
const mediaListStatusSchema = z.enum([
  'CURRENT',
  'PLANNING',
  'COMPLETED',
  'DROPPED',
  'PAUSED',
  'REPEATING',
]);
const mediaSeasonSchema = z.enum(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
const mediaSortSchema = z.enum([
  'POPULARITY_DESC',
  'SCORE_DESC',
  'TRENDING_DESC',
  'START_DATE_DESC',
  'FAVOURITES_DESC',
  'SEARCH_MATCH',
]);
const fuzzyDateSchema = z.object({
  year: z.number().optional(),
  month: z.number().optional(),
  day: z.number().optional(),
});
const mediaLookupSchema = z
  .object({
    id: z.number().optional().describe('AniList media ID'),
    idMal: z.number().optional().describe('MyAnimeList media ID'),
  })
  .refine((value) => value.id !== undefined || value.idMal !== undefined, {
    message: 'Provide either id or idMal.',
  });

type FuzzyDateInput = z.infer<typeof fuzzyDateSchema>;

async function getAnilistToken(): Promise<string | null> {
  const dbToken = await getValidToken('anilist');
  if (dbToken) return dbToken;
  return config.ANILIST_TOKEN ?? null;
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  requireAuth = false,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const token = await getAnilistToken();
  if (requireAuth && !token) {
    throw new Error(
      'AniList is not connected. Please connect AniList in Connections first.',
    );
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables: cleanVariables(variables) }),
  });

  const text = await res.text();
  let json: {
    data?: T;
    errors?: Array<{ message?: string; status?: number }>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`AniList API ${res.status}: ${text}`);
  }

  if (!res.ok || json.errors?.length) {
    const message =
      json.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join('; ') || `AniList API ${res.status}`;
    throw new Error(message);
  }

  if (!json.data) throw new Error('AniList returned no data.');
  return json.data;
}

function cleanVariables(
  variables: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(variables).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}

function perPage(value: number | undefined, fallback = 5): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), MAX_PER_PAGE);
}

function page(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 1;
  return Math.max(Math.floor(value), 1);
}

function yearStart(year?: number): number | null {
  return year ? Number(`${year}0101`) : null;
}

function yearEnd(year?: number): number | null {
  return year ? Number(`${year}1231`) : null;
}

function dateInput(value?: FuzzyDateInput): FuzzyDateInput | null {
  if (!value) return null;
  if (!value.year && !value.month && !value.day) return null;
  return value;
}

function sortList(sort: string | undefined, fallback: string): string[] {
  return [sort ?? fallback];
}

async function getAuthenticatedAniListUserName(): Promise<string> {
  const data = await gql<{ Viewer: { name: string } }>(
    `query {
      Viewer {
        name
      }
    }`,
    {},
    true,
  );

  return data.Viewer.name;
}

const mediaFields = `
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
`;

/* ─── Search and discovery ───────────────────────────────────────────────── */

export const searchAnime = tool(
  async ({
    query,
    perPage: perPageInput,
    page: pageInput,
    year,
    season,
    genre,
    tag,
  }) => {
    try {
      const data = await gql<{ Page: { pageInfo: unknown; media: unknown[] } }>(
        `query($search: String, $page: Int, $perPage: Int, $seasonYear: Int, $season: MediaSeason, $genre: String, $tag: String) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage }
            media(search: $search, type: ANIME, sort: [POPULARITY_DESC], seasonYear: $seasonYear, season: $season, genre: $genre, tag: $tag, isAdult: false) {
              ${mediaFields}
            }
          }
        }`,
        {
          search: query ?? null,
          page: page(pageInput),
          perPage: perPage(perPageInput),
          seasonYear: year ?? null,
          season: season ?? null,
          genre: genre ?? null,
          tag: tag ?? null,
        },
      );
      return JSON.stringify(data.Page);
    } catch (error) {
      logger.error('[anilist] searchAnime', error);
      return `Error searching anime: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_anime',
    description:
      'Search for anime on AniList by title/keyword, optionally filtered by year, season, genre, or tag.',
    schema: z.object({
      query: z.string().optional().describe('Search query'),
      perPage: z.number().optional().describe('Number of results, max 25'),
      page: z.number().optional().describe('Result page, default 1'),
      year: z.number().optional().describe('Season year, e.g. 2024'),
      season: mediaSeasonSchema.optional().describe('Release season'),
      genre: z.string().optional().describe('Genre filter, e.g. "Action"'),
      tag: z
        .string()
        .optional()
        .describe('Tag filter, e.g. "Time Manipulation"'),
    }),
  },
);

export const searchManga = tool(
  async ({
    query,
    perPage: perPageInput,
    page: pageInput,
    year,
    genre,
    tag,
  }) => {
    try {
      const data = await gql<{ Page: { pageInfo: unknown; media: unknown[] } }>(
        `query($search: String, $page: Int, $perPage: Int, $startGreater: FuzzyDateInt, $startLesser: FuzzyDateInt, $genre: String, $tag: String) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage }
            media(search: $search, type: MANGA, sort: [POPULARITY_DESC], startDate_greater: $startGreater, startDate_lesser: $startLesser, genre: $genre, tag: $tag, isAdult: false) {
              ${mediaFields}
            }
          }
        }`,
        {
          search: query ?? null,
          page: page(pageInput),
          perPage: perPage(perPageInput),
          startGreater: yearStart(year),
          startLesser: yearEnd(year),
          genre: genre ?? null,
          tag: tag ?? null,
        },
      );
      return JSON.stringify(data.Page);
    } catch (error) {
      logger.error('[anilist] searchManga', error);
      return `Error searching manga: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_manga',
    description:
      'Search for manga on AniList by title/keyword, optionally filtered by start year, genre, or tag.',
    schema: z.object({
      query: z.string().optional().describe('Search query'),
      perPage: z.number().optional().describe('Number of results, max 25'),
      page: z.number().optional().describe('Result page, default 1'),
      year: z.number().optional().describe('Start year, e.g. 2020'),
      genre: z.string().optional().describe('Genre filter, e.g. "Action"'),
      tag: z.string().optional().describe('Tag filter, e.g. "Isekai"'),
    }),
  },
);

export const discoverMedia = tool(
  async ({
    type,
    query,
    perPage: perPageInput,
    page: pageInput,
    sort,
    year,
    season,
    status,
    genre,
    tag,
    onList,
  }) => {
    try {
      const data = await gql<{ Page: { pageInfo: unknown; media: unknown[] } }>(
        `query($type: MediaType, $search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $seasonYear: Int, $season: MediaSeason, $status: MediaStatus, $genre: String, $tag: String, $onList: Boolean) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage }
            media(type: $type, search: $search, sort: $sort, seasonYear: $seasonYear, season: $season, status: $status, genre: $genre, tag: $tag, onList: $onList, isAdult: false) {
              ${mediaFields}
            }
          }
        }`,
        {
          type,
          search: query ?? null,
          page: page(pageInput),
          perPage: perPage(perPageInput, 10),
          sort: sortList(sort, query ? 'SEARCH_MATCH' : 'TRENDING_DESC'),
          seasonYear: year ?? null,
          season: season ?? null,
          status: status ?? null,
          genre: genre ?? null,
          tag: tag ?? null,
          onList: onList ?? null,
        },
        onList !== undefined,
      );
      return JSON.stringify(data.Page);
    } catch (error) {
      logger.error('[anilist] discoverMedia', error);
      return `Error discovering media: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'discover_media',
    description:
      'Discover anime or manga using AniList filters such as trending, score, popularity, year, season, status, genre, tag, and whether it is on the authenticated user list.',
    schema: z.object({
      type: mediaTypeSchema.describe('ANIME or MANGA'),
      query: z.string().optional().describe('Optional title/keyword search'),
      perPage: z.number().optional().describe('Number of results, max 25'),
      page: z.number().optional().describe('Result page, default 1'),
      sort: mediaSortSchema.optional().describe('Sort order'),
      year: z.number().optional().describe('Season year for anime'),
      season: mediaSeasonSchema.optional().describe('Anime release season'),
      status: z
        .enum([
          'FINISHED',
          'RELEASING',
          'NOT_YET_RELEASED',
          'CANCELLED',
          'HIATUS',
        ])
        .optional(),
      genre: z.string().optional(),
      tag: z.string().optional(),
      onList: z
        .boolean()
        .optional()
        .describe('Filter by authenticated user list membership'),
    }),
  },
);

export const getGenresAndTags = tool(
  async () => {
    try {
      const data = await gql<{
        GenreCollection: string[];
        MediaTagCollection: unknown[];
      }>(
        `query {
          GenreCollection
          MediaTagCollection {
            id name description category rank isGeneralSpoiler isMediaSpoiler isAdult
          }
        }`,
      );
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[anilist] getGenresAndTags', error);
      return `Error fetching AniList genres/tags: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_anilist_genres_and_tags',
    description:
      'Get AniList genre and tag metadata for helping with search and recommendations.',
    schema: z.object({}),
  },
);

/* ─── Fetch by ID ─────────────────────────────────────────────────────────── */

export const getAnime = tool(
  async ({ id, idMal }) => {
    try {
      const data = await gql<{ Media: unknown }>(
        `query($id: Int, $idMal: Int) {
          Media(id: $id, idMal: $idMal, type: ANIME) {
            ${mediaFields}
            relations {
              edges {
                relationType
                node { id title { romaji english userPreferred } type format status siteUrl }
              }
            }
            characters(page: 1, perPage: 10, sort: [ROLE, RELEVANCE, ID]) {
              edges {
                role
                node { id name { full native userPreferred } siteUrl }
                voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) {
                  id name { full userPreferred } languageV2 siteUrl
                }
              }
            }
            externalLinks { id site url type language color icon }
            streamingEpisodes { title thumbnail url site }
          }
        }`,
        { id: id ?? null, idMal: idMal ?? null },
      );
      return JSON.stringify(data.Media);
    } catch (error) {
      logger.error('[anilist] getAnime', error);
      return `Error fetching anime: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_anime',
    description: 'Get detailed info about an anime by AniList ID or MAL ID.',
    schema: mediaLookupSchema,
  },
);

export const getManga = tool(
  async ({ id, idMal }) => {
    try {
      const data = await gql<{ Media: unknown }>(
        `query($id: Int, $idMal: Int) {
          Media(id: $id, idMal: $idMal, type: MANGA) {
            ${mediaFields}
            relations {
              edges {
                relationType
                node { id title { romaji english userPreferred } type format status siteUrl }
              }
            }
            characters(page: 1, perPage: 10, sort: [ROLE, RELEVANCE, ID]) {
              edges {
                role
                node { id name { full native userPreferred } siteUrl }
              }
            }
            externalLinks { id site url type language color icon }
          }
        }`,
        { id: id ?? null, idMal: idMal ?? null },
      );
      return JSON.stringify(data.Media);
    } catch (error) {
      logger.error('[anilist] getManga', error);
      return `Error fetching manga: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_manga',
    description: 'Get detailed info about a manga by AniList ID or MAL ID.',
    schema: mediaLookupSchema,
  },
);

export const getAiringSchedule = tool(
  async ({ mediaId, daysAhead, perPage: perPageInput }) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const end = now + (daysAhead ?? 14) * 24 * 60 * 60;
      const data = await gql<{
        Page: { pageInfo: unknown; airingSchedules: unknown[] };
      }>(
        `query($mediaId: Int, $airingAtGreater: Int, $airingAtLesser: Int, $perPage: Int) {
          Page(page: 1, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage }
            airingSchedules(mediaId: $mediaId, airingAt_greater: $airingAtGreater, airingAt_lesser: $airingAtLesser, sort: [TIME]) {
              id airingAt timeUntilAiring episode mediaId
              media { id title { romaji english userPreferred } type format status episodes coverImage { medium } siteUrl }
            }
          }
        }`,
        {
          mediaId: mediaId ?? null,
          airingAtGreater: now,
          airingAtLesser: end,
          perPage: perPage(perPageInput, 10),
        },
      );
      return JSON.stringify(data.Page);
    } catch (error) {
      logger.error('[anilist] getAiringSchedule', error);
      return `Error fetching airing schedule: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_airing_schedule',
    description:
      'Get upcoming AniList airing episodes, optionally for a specific anime media ID.',
    schema: z.object({
      mediaId: z.number().optional().describe('AniList anime media ID'),
      daysAhead: z
        .number()
        .optional()
        .describe('How many days ahead to search'),
      perPage: z.number().optional().describe('Number of results, max 25'),
    }),
  },
);

/* ─── People and studios ─────────────────────────────────────────────────── */

export const searchCharacters = tool(
  async ({ query, perPage: perPageInput }) => {
    try {
      const data = await gql<{ Page: { characters: unknown[] } }>(
        `query($search: String, $perPage: Int) {
          Page(page: 1, perPage: $perPage) {
            characters(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
              id name { full native userPreferred } image { large } gender age favourites siteUrl
              media(page: 1, perPage: 5, sort: [POPULARITY_DESC]) {
                nodes { id title { romaji english userPreferred } type format siteUrl }
              }
            }
          }
        }`,
        { search: query, perPage: perPage(perPageInput) },
      );
      return JSON.stringify(data.Page.characters);
    } catch (error) {
      logger.error('[anilist] searchCharacters', error);
      return `Error searching characters: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_anilist_characters',
    description: 'Search AniList characters by name.',
    schema: z.object({
      query: z.string().describe('Character name search'),
      perPage: z.number().optional().describe('Number of results, max 25'),
    }),
  },
);

export const searchStaff = tool(
  async ({ query, perPage: perPageInput }) => {
    try {
      const data = await gql<{ Page: { staff: unknown[] } }>(
        `query($search: String, $perPage: Int) {
          Page(page: 1, perPage: $perPage) {
            staff(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
              id name { full native userPreferred } languageV2 image { large }
              primaryOccupations age yearsActive homeTown favourites siteUrl
              staffMedia(page: 1, perPage: 5, sort: [POPULARITY_DESC]) {
                nodes { id title { romaji english userPreferred } type format siteUrl }
              }
            }
          }
        }`,
        { search: query, perPage: perPage(perPageInput) },
      );
      return JSON.stringify(data.Page.staff);
    } catch (error) {
      logger.error('[anilist] searchStaff', error);
      return `Error searching staff: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_anilist_staff',
    description: 'Search AniList staff or voice actors by name.',
    schema: z.object({
      query: z.string().describe('Staff or voice actor name search'),
      perPage: z.number().optional().describe('Number of results, max 25'),
    }),
  },
);

export const searchStudios = tool(
  async ({ query, perPage: perPageInput }) => {
    try {
      const data = await gql<{ Page: { studios: unknown[] } }>(
        `query($search: String, $perPage: Int) {
          Page(page: 1, perPage: $perPage) {
            studios(search: $search, sort: [SEARCH_MATCH, FAVOURITES_DESC]) {
              id name isAnimationStudio favourites siteUrl
              media(page: 1, perPage: 5, sort: [POPULARITY_DESC], isMain: true) {
                nodes { id title { romaji english userPreferred } type format averageScore siteUrl }
              }
            }
          }
        }`,
        { search: query, perPage: perPage(perPageInput) },
      );
      return JSON.stringify(data.Page.studios);
    } catch (error) {
      logger.error('[anilist] searchStudios', error);
      return `Error searching studios: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_anilist_studios',
    description: 'Search AniList studios by name.',
    schema: z.object({
      query: z.string().describe('Studio name search'),
      perPage: z.number().optional().describe('Number of results, max 25'),
    }),
  },
);

/* ─── User lists (requires auth for omitted username and writes) ─────────── */

export const getViewer = tool(
  async () => {
    try {
      const data = await gql<{ Viewer: unknown }>(
        `query {
          Viewer {
            id name about avatar { large } bannerImage siteUrl
            options { titleLanguage displayAdultContent airingNotifications profileColor timezone }
            mediaListOptions { scoreFormat rowOrder animeList { sectionOrder customLists advancedScoring advancedScoringEnabled } mangaList { sectionOrder customLists advancedScoring advancedScoringEnabled } }
            statistics {
              anime { count episodesWatched minutesWatched meanScore statuses { status count } genres { genre count meanScore } }
              manga { count chaptersRead volumesRead meanScore statuses { status count } genres { genre count meanScore } }
            }
          }
        }`,
        {},
        true,
      );
      return JSON.stringify(data.Viewer);
    } catch (error) {
      logger.error('[anilist] getViewer', error);
      return `Error fetching authenticated AniList viewer: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_anilist_viewer',
    description:
      'Get the authenticated AniList account profile, settings, score format, custom lists, and stats.',
    schema: z.object({}),
  },
);

export const getUserAnimeList = tool(
  async ({ userName, status }) => {
    try {
      const targetUserName =
        userName ?? (await getAuthenticatedAniListUserName());
      const data = await gql<{ MediaListCollection: unknown }>(
        `query($userName: String, $status: MediaListStatus) {
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
        }`,
        { userName: targetUserName, status: status ?? null },
        !userName,
      );
      return JSON.stringify(data.MediaListCollection);
    } catch (error) {
      logger.error('[anilist] getUserAnimeList', error);
      return `Error fetching anime list: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_user_anime_list',
    description:
      "Get a user's AniList anime list, including list entry IDs for updates/deletes. If userName is omitted, uses the authenticated account.",
    schema: z.object({
      userName: z.string().optional().describe('AniList username'),
      status: mediaListStatusSchema.optional(),
    }),
  },
);

export const getUserMangaList = tool(
  async ({ userName, status }) => {
    try {
      const targetUserName =
        userName ?? (await getAuthenticatedAniListUserName());
      const data = await gql<{ MediaListCollection: unknown }>(
        `query($userName: String, $status: MediaListStatus) {
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
        }`,
        { userName: targetUserName, status: status ?? null },
        !userName,
      );
      return JSON.stringify(data.MediaListCollection);
    } catch (error) {
      logger.error('[anilist] getUserMangaList', error);
      return `Error fetching manga list: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_user_manga_list',
    description:
      "Get a user's AniList manga list, including list entry IDs for updates/deletes. If userName is omitted, uses the authenticated account.",
    schema: z.object({
      userName: z.string().optional().describe('AniList username'),
      status: mediaListStatusSchema.optional(),
    }),
  },
);

export const getMediaListEntry = tool(
  async ({ mediaId, userName }) => {
    try {
      const targetUserName =
        userName ?? (await getAuthenticatedAniListUserName());
      const data = await gql<{ MediaList: unknown }>(
        `query($mediaId: Int, $userName: String) {
          MediaList(mediaId: $mediaId, userName: $userName) {
            id mediaId status score(format: POINT_10_DECIMAL) progress progressVolumes
            repeat priority private notes hiddenFromStatusLists customLists advancedScores
            startedAt { year month day } completedAt { year month day }
            createdAt updatedAt
            media { id title { romaji english userPreferred } type format status episodes chapters volumes siteUrl }
          }
        }`,
        { mediaId, userName: targetUserName },
        !userName,
      );
      return JSON.stringify(data.MediaList);
    } catch (error) {
      logger.error('[anilist] getMediaListEntry', error);
      return `Error fetching media list entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_media_list_entry',
    description:
      'Get one AniList list entry by media ID and optional username. Use this before updating or deleting when only mediaId/title is known.',
    schema: z.object({
      mediaId: z.number().describe('AniList media ID'),
      userName: z.string().optional().describe('AniList username'),
    }),
  },
);

const listMutationSchema = z
  .object({
    mediaId: z.number().optional().describe('AniList media ID'),
    entryId: z.number().optional().describe('AniList media list entry ID'),
    status: mediaListStatusSchema.optional(),
    score: z.number().optional().describe('Score in the user score format'),
    scoreRaw: z
      .number()
      .optional()
      .describe('Raw score value for advanced formats'),
    progress: z.number().optional().describe('Episodes/chapters watched/read'),
    progressVolumes: z.number().optional().describe('Manga volumes read'),
    repeat: z.number().optional().describe('Rewatch/reread count'),
    priority: z.number().optional().describe('Priority number'),
    private: z
      .boolean()
      .optional()
      .describe('Whether this list entry is private'),
    notes: z.string().optional().describe('Private notes for the list entry'),
    hiddenFromStatusLists: z.boolean().optional(),
    startedAt: fuzzyDateSchema.optional(),
    completedAt: fuzzyDateSchema.optional(),
  })
  .refine(
    (value) => value.mediaId !== undefined || value.entryId !== undefined,
    {
      message: 'Provide either mediaId or entryId.',
    },
  );

export const addListEntry = tool(
  async ({
    mediaId,
    entryId,
    status,
    score,
    scoreRaw,
    progress,
    progressVolumes,
    repeat,
    priority,
    private: isPrivate,
    notes,
    hiddenFromStatusLists,
    startedAt,
    completedAt,
  }) => {
    try {
      const data = await gql<{ SaveMediaListEntry: unknown }>(
        `mutation($id: Int, $mediaId: Int, $status: MediaListStatus, $score: Float, $scoreRaw: Int, $progress: Int, $progressVolumes: Int, $repeat: Int, $priority: Int, $private: Boolean, $notes: String, $hiddenFromStatusLists: Boolean, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
          SaveMediaListEntry(id: $id, mediaId: $mediaId, status: $status, score: $score, scoreRaw: $scoreRaw, progress: $progress, progressVolumes: $progressVolumes, repeat: $repeat, priority: $priority, private: $private, notes: $notes, hiddenFromStatusLists: $hiddenFromStatusLists, startedAt: $startedAt, completedAt: $completedAt) {
            id mediaId status score(format: POINT_10_DECIMAL) progress progressVolumes repeat priority private notes hiddenFromStatusLists updatedAt
            startedAt { year month day } completedAt { year month day }
            media { id title { romaji english userPreferred } type format siteUrl }
          }
        }`,
        {
          id: entryId ?? null,
          mediaId: mediaId ?? null,
          status: status ?? null,
          score: score ?? null,
          scoreRaw: scoreRaw ?? null,
          progress: progress ?? null,
          progressVolumes: progressVolumes ?? null,
          repeat: repeat ?? null,
          priority: priority ?? null,
          private: isPrivate ?? null,
          notes: notes ?? null,
          hiddenFromStatusLists: hiddenFromStatusLists ?? null,
          startedAt: dateInput(startedAt),
          completedAt: dateInput(completedAt),
        },
        true,
      );
      return JSON.stringify(data.SaveMediaListEntry);
    } catch (error) {
      logger.error('[anilist] addListEntry', error);
      return `Error saving list entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'add_list_entry',
    description:
      "Add or update an anime/manga entry in the authenticated user's AniList by mediaId or existing entryId.",
    schema: listMutationSchema,
  },
);

export const updateListEntry = tool(async (args) => addListEntry.invoke(args), {
  name: 'update_list_entry',
  description:
    'Update an existing AniList list entry. entryId is preferred; mediaId also works through SaveMediaListEntry.',
  schema: listMutationSchema,
});

export const removeListEntry = tool(
  async ({ entryId }) => {
    try {
      const data = await gql<{ DeleteMediaListEntry: { deleted: boolean } }>(
        `mutation($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
        { id: entryId },
        true,
      );
      return data.DeleteMediaListEntry.deleted
        ? 'Entry deleted.'
        : 'Entry not found.';
    } catch (error) {
      logger.error('[anilist] removeListEntry', error);
      return `Error removing list entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'remove_list_entry',
    description:
      "Remove an entry from the authenticated user's AniList by media list entry ID. Ask for confirmation before using.",
    schema: z.object({
      entryId: z.number().describe('AniList media list entry ID'),
    }),
  },
);

export const toggleFavourite = tool(
  async ({ type, id }) => {
    try {
      const variables = {
        animeId: type === 'ANIME' ? id : null,
        mangaId: type === 'MANGA' ? id : null,
        characterId: type === 'CHARACTER' ? id : null,
        staffId: type === 'STAFF' ? id : null,
        studioId: type === 'STUDIO' ? id : null,
      };
      const data = await gql<{ ToggleFavourite: unknown }>(
        `mutation($animeId: Int, $mangaId: Int, $characterId: Int, $staffId: Int, $studioId: Int) {
          ToggleFavourite(animeId: $animeId, mangaId: $mangaId, characterId: $characterId, staffId: $staffId, studioId: $studioId) {
            anime { nodes { id title { userPreferred } isFavourite } }
            manga { nodes { id title { userPreferred } isFavourite } }
            characters { nodes { id name { userPreferred } isFavourite } }
            staff { nodes { id name { userPreferred } isFavourite } }
            studios { nodes { id name isFavourite } }
          }
        }`,
        variables,
        true,
      );
      return JSON.stringify(data.ToggleFavourite);
    } catch (error) {
      logger.error('[anilist] toggleFavourite', error);
      return `Error toggling favourite: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'toggle_anilist_favourite',
    description:
      'Toggle favourite status for anime, manga, character, staff, or studio. Ask for confirmation before using.',
    schema: z.object({
      type: z.enum(['ANIME', 'MANGA', 'CHARACTER', 'STAFF', 'STUDIO']),
      id: z.number().describe('AniList ID for the selected type'),
    }),
  },
);

/* ─── User profile and recommendations ───────────────────────────────────── */

export const getUserProfile = tool(
  async ({ userName }) => {
    try {
      if (!userName) {
        const viewer = await getViewer.invoke({});
        return typeof viewer === 'string' ? viewer : JSON.stringify(viewer);
      }

      const data = await gql<{ User: unknown }>(
        `query($name: String) {
          User(name: $name) {
            id name about avatar { large } bannerImage siteUrl
            statistics {
              anime { count episodesWatched minutesWatched meanScore statuses { status count } genres { genre count meanScore } }
              manga { count chaptersRead volumesRead meanScore statuses { status count } genres { genre count meanScore } }
            }
          }
        }`,
        { name: userName },
      );
      return JSON.stringify(data.User);
    } catch (error) {
      logger.error('[anilist] getUserProfile', error);
      return `Error fetching profile: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_user_profile',
    description:
      "Get an AniList user's profile and watch/read statistics. If userName is omitted, gets the authenticated viewer.",
    schema: z.object({
      userName: z.string().optional().describe('AniList username'),
    }),
  },
);

export const getRecommendations = tool(
  async ({ mediaId, perPage: perPageInput }) => {
    try {
      const data = await gql<{
        Media: { recommendations: { nodes: unknown[] } };
      }>(
        `query($id: Int, $perPage: Int) {
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
        }`,
        { id: mediaId, perPage: perPage(perPageInput, 10) },
      );
      return JSON.stringify(data.Media);
    } catch (error) {
      logger.error('[anilist] getRecommendations', error);
      return `Error fetching recommendations: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_recommendations_for_media',
    description:
      'Get community recommendations for a given anime or manga by AniList ID.',
    schema: z.object({
      mediaId: z.number().describe('AniList media ID'),
      perPage: z
        .number()
        .optional()
        .describe('Number of recommendations, max 25'),
    }),
  },
);

export const anilistTools = [
  searchAnime,
  searchManga,
  discoverMedia,
  getGenresAndTags,
  getAnime,
  getManga,
  getAiringSchedule,
  searchCharacters,
  searchStaff,
  searchStudios,
  getViewer,
  getUserAnimeList,
  getUserMangaList,
  getMediaListEntry,
  addListEntry,
  updateListEntry,
  removeListEntry,
  toggleFavourite,
  getUserProfile,
  getRecommendations,
];
