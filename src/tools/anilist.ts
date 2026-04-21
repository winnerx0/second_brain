import { tool } from 'langchain';
import { z } from 'zod';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { db } from '../db/client.ts';
import { connections } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

const ANILIST_URL = 'https://graphql.anilist.co';

async function getAnilistToken(): Promise<string | null> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(eq(connections.name, 'anilist'))
    .limit(1);

  if (conn?.oauthConnected && conn.accessToken) {
    return conn.accessToken;
  }

  // Fallback to environment variable
  return config.ANILIST_TOKEN ?? null;
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  requireAuth = false,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const token = await getAnilistToken();
    if (!token) {
      throw new Error(
        'AniList is not connected. Please connect AniList in Connections first.',
      );
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data as T;
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

/* ─── Search ──────────────────────────────────────────────────────────────── */

export const searchAnime = tool(
  async ({ query, perPage }) => {
    try {
      const data = await gql<{ Page: { media: unknown[] } }>(
        `query($search: String, $perPage: Int) {
          Page(perPage: $perPage) {
            media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
              id title { romaji english } status episodes averageScore genres
              description(asHtml: false) startDate { year }
            }
          }
        }`,
        { search: query, perPage: perPage ?? 5 },
      );
      return JSON.stringify(data.Page.media);
    } catch (error) {
      logger.error('[anilist] searchAnime', error);
      return `Error searching anime: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_anime',
    description: 'Search for anime on AniList by title or keyword.',
    schema: z.object({
      query: z.string().describe('Search query'),
      perPage: z.number().optional().describe('Number of results (default 5)'),
    }),
  },
);

export const searchManga = tool(
  async ({ query, perPage }) => {
    try {
      const data = await gql<{ Page: { media: unknown[] } }>(
        `query($search: String, $perPage: Int) {
          Page(perPage: $perPage) {
            media(search: $search, type: MANGA, sort: POPULARITY_DESC) {
              id title { romaji english } status chapters volumes averageScore genres
              description(asHtml: false) startDate { year }
            }
          }
        }`,
        { search: query, perPage: perPage ?? 5 },
      );
      return JSON.stringify(data.Page.media);
    } catch (error) {
      logger.error('[anilist] searchManga', error);
      return `Error searching manga: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_manga',
    description: 'Search for manga on AniList by title or keyword.',
    schema: z.object({
      query: z.string().describe('Search query'),
      perPage: z.number().optional().describe('Number of results (default 5)'),
    }),
  },
);

/* ─── Fetch by ID ─────────────────────────────────────────────────────────── */

export const getAnime = tool(
  async ({ id }) => {
    try {
      const data = await gql<{ Media: unknown }>(
        `query($id: Int) {
          Media(id: $id, type: ANIME) {
            id title { romaji english native } status episodes duration averageScore
            popularity genres tags { name } description(asHtml: false)
            startDate { year month day } endDate { year month day }
            studios { nodes { name isAnimationStudio } }
            nextAiringEpisode { episode airingAt }
          }
        }`,
        { id },
      );
      return JSON.stringify(data.Media);
    } catch (error) {
      logger.error('[anilist] getAnime', error);
      return `Error fetching anime: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_anime',
    description: 'Get detailed info about an anime by its AniList ID.',
    schema: z.object({
      id: z.number().describe('AniList media ID'),
    }),
  },
);

export const getManga = tool(
  async ({ id }) => {
    try {
      const data = await gql<{ Media: unknown }>(
        `query($id: Int) {
          Media(id: $id, type: MANGA) {
            id title { romaji english native } status chapters volumes averageScore
            popularity genres tags { name } description(asHtml: false)
            startDate { year month day } endDate { year month day }
          }
        }`,
        { id },
      );
      return JSON.stringify(data.Media);
    } catch (error) {
      logger.error('[anilist] getManga', error);
      return `Error fetching manga: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_manga',
    description: 'Get detailed info about a manga by its AniList ID.',
    schema: z.object({
      id: z.number().describe('AniList media ID'),
    }),
  },
);

/* ─── User lists (requires auth) ─────────────────────────────────────────── */

export const getUserAnimeList = tool(
  async ({ userName, status }) => {
    try {
      const targetUserName = userName ?? (await getAuthenticatedAniListUserName());
      const data = await gql<{
        MediaListCollection: unknown;
      }>(
        `query($userName: String, $status: MediaListStatus) {
          MediaListCollection(userName: $userName, type: ANIME, status: $status) {
            lists {
              name entries {
                mediaId
                myRating: score(format: POINT_10_DECIMAL)
                myRating100: score(format: POINT_100)
                progress
                updatedAt
                media { title { romaji english } episodes status }
              }
            }
          }
        }`,
        { userName: targetUserName, status: status ?? null },
        true,
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
      "Get a user's AniList anime list, optionally filtered by status. If userName is omitted, uses the authenticated AniList account.",
    schema: z.object({
      userName: z
        .string()
        .optional()
        .describe('AniList username (optional; defaults to authenticated user)'),
      status: z
        .enum([
          'CURRENT',
          'PLANNING',
          'COMPLETED',
          'DROPPED',
          'PAUSED',
          'REPEATING',
        ])
        .optional(),
    }),
  },
);

export const getUserMangaList = tool(
  async ({ userName, status }) => {
    try {
      const targetUserName = userName ?? (await getAuthenticatedAniListUserName());
      const data = await gql<{
        MediaListCollection: unknown;
      }>(
        `query($userName: String, $status: MediaListStatus) {
          MediaListCollection(userName: $userName, type: MANGA, status: $status) {
            lists {
              name entries {
                mediaId
                myRating: score(format: POINT_10_DECIMAL)
                myRating100: score(format: POINT_100)
                progress
                updatedAt
                media { title { romaji english } chapters status }
              }
            }
          }
        }`,
        { userName: targetUserName, status: status ?? null },
        true,
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
      "Get a user's AniList manga list, optionally filtered by status. If userName is omitted, uses the authenticated AniList account.",
    schema: z.object({
      userName: z
        .string()
        .optional()
        .describe('AniList username (optional; defaults to authenticated user)'),
      status: z
        .enum([
          'CURRENT',
          'PLANNING',
          'COMPLETED',
          'DROPPED',
          'PAUSED',
          'REPEATING',
        ])
        .optional(),
    }),
  },
);

export const addListEntry = tool(
  async ({ mediaId, status, score, progress }) => {
    try {
      const data = await gql<{
        SaveMediaListEntry: { id: number };
      }>(
        `mutation($mediaId: Int, $status: MediaListStatus, $score: Float, $progress: Int) {
          SaveMediaListEntry(mediaId: $mediaId, status: $status, score: $score, progress: $progress) {
            id status score progress
          }
        }`,
        {
          mediaId,
          status,
          score: score ?? null,
          progress: progress ?? null,
        },
        true,
      );
      return JSON.stringify(data.SaveMediaListEntry);
    } catch (error) {
      logger.error('[anilist] addListEntry', error);
      return `Error adding list entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'add_list_entry',
    description:
      "Add or update an anime/manga entry in the authenticated user's AniList. Supports score-only updates when mediaId is known.",
    schema: z.object({
      mediaId: z.number().describe('AniList media ID'),
      status: z
        .enum([
          'CURRENT',
          'PLANNING',
          'COMPLETED',
          'DROPPED',
          'PAUSED',
          'REPEATING',
        ])
        .optional(),
      score: z.number().optional().describe('Score 0-10'),
      progress: z
        .number()
        .optional()
        .describe('Episodes/chapters watched/read'),
    }),
  },
);

export const updateListEntry = tool(
  async ({ entryId, status, score, progress }) => {
    try {
      const data = await gql<{ SaveMediaListEntry: unknown }>(
        `mutation($id: Int, $status: MediaListStatus, $score: Float, $progress: Int) {
          SaveMediaListEntry(id: $id, status: $status, score: $score, progress: $progress) {
            id status score progress
          }
        }`,
        {
          id: entryId,
          status: status ?? null,
          score: score ?? null,
          progress: progress ?? null,
        },
        true,
      );
      return JSON.stringify(data.SaveMediaListEntry);
    } catch (error) {
      logger.error('[anilist] updateListEntry', error);
      return `Error updating list entry: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'update_list_entry',
    description: 'Update an existing AniList list entry by its entry ID.',
    schema: z.object({
      entryId: z.number().describe('AniList media list entry ID'),
      status: z
        .enum([
          'CURRENT',
          'PLANNING',
          'COMPLETED',
          'DROPPED',
          'PAUSED',
          'REPEATING',
        ])
        .optional(),
      score: z.number().optional(),
      progress: z.number().optional(),
    }),
  },
);

export const removeListEntry = tool(
  async ({ entryId }) => {
    try {
      const data = await gql<{
        DeleteMediaListEntry: { deleted: boolean };
      }>(
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
      "Remove an entry from the authenticated user's AniList by entry ID.",
    schema: z.object({
      entryId: z.number().describe('AniList media list entry ID'),
    }),
  },
);

/* ─── User profile ────────────────────────────────────────────────────────── */

export const getUserProfile = tool(
  async ({ userName }) => {
    try {
      const data = await gql<{ User: unknown }>(
        `query($name: String) {
          User(name: $name) {
            id name about avatar { large }
            statistics {
              anime { count episodesWatched minutesWatched meanScore }
              manga { count chaptersRead volumesRead meanScore }
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
    description: "Get an AniList user's profile and watch/read statistics.",
    schema: z.object({
      userName: z.string().describe('AniList username'),
    }),
  },
);

export const getRecommendations = tool(
  async ({ mediaId }) => {
    try {
      const data = await gql<{
        Media: {
          recommendations: { nodes: unknown[] };
        };
      }>(
        `query($id: Int) {
          Media(id: $id) {
            recommendations(sort: RATING_DESC, page: 1, perPage: 10) {
              nodes {
                rating
                mediaRecommendation {
                  id title { romaji english } type status averageScore
                  description(asHtml: false)
                }
              }
            }
          }
        }`,
        { id: mediaId },
      );
      return JSON.stringify(data.Media.recommendations.nodes);
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
    }),
  },
);

export const anilistTools = [
  searchAnime,
  searchManga,
  getAnime,
  getManga,
  getUserAnimeList,
  getUserMangaList,
  addListEntry,
  updateListEntry,
  removeListEntry,
  getUserProfile,
  getRecommendations,
];
