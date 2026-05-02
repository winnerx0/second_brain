import { tool } from 'langchain';
import { z } from 'zod';
import { logger } from '../logger.ts';
import { getValidToken } from '../oauth.ts';

const SPOTIFY_API_URL = 'https://api.spotify.com/v1';

type SpotifyFetchOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

async function getSpotifyToken(): Promise<string> {
  const token = await getValidToken('spotify');
  if (!token) {
    throw new Error(
      'Spotify is not connected. Please connect Spotify in Connections first.',
    );
  }
  return token;
}

function buildUrl(path: string, query?: SpotifyFetchOptions['query']): string {
  const url = new URL(`${SPOTIFY_API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function spotifyFetch<T>(
  path: string,
  options: SpotifyFetchOptions = {},
): Promise<T | null> {
  const token = await getSpotifyToken();
  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? JSON.stringify((data as { error: unknown }).error)
        : text;
    throw new Error(`Spotify API request failed (${res.status}): ${message}`);
  }

  return data as T;
}

function summarizeTrack(item: unknown) {
  if (!item || typeof item !== 'object') return item;
  const track = item as {
    id?: string;
    name?: string;
    uri?: string;
    external_urls?: { spotify?: string };
    artists?: Array<{ name?: string }>;
    album?: { name?: string; release_date?: string };
    duration_ms?: number;
    popularity?: number;
  };

  return {
    id: track.id,
    name: track.name,
    artists: track.artists?.map((artist) => artist.name).filter(Boolean),
    album: track.album?.name,
    releaseDate: track.album?.release_date,
    durationMs: track.duration_ms,
    popularity: track.popularity,
    uri: track.uri,
    url: track.external_urls?.spotify,
  };
}

function summarizeArtist(item: unknown) {
  if (!item || typeof item !== 'object') return item;
  const artist = item as {
    id?: string;
    name?: string;
    uri?: string;
    external_urls?: { spotify?: string };
    genres?: string[];
    popularity?: number;
  };

  return {
    id: artist.id,
    name: artist.name,
    genres: artist.genres,
    popularity: artist.popularity,
    uri: artist.uri,
    url: artist.external_urls?.spotify,
  };
}

function summarizeAlbum(item: unknown) {
  if (!item || typeof item !== 'object') return item;
  const album = item as {
    id?: string;
    name?: string;
    uri?: string;
    external_urls?: { spotify?: string };
    artists?: Array<{ name?: string }>;
    release_date?: string;
    total_tracks?: number;
  };

  return {
    id: album.id,
    name: album.name,
    artists: album.artists?.map((artist) => artist.name).filter(Boolean),
    releaseDate: album.release_date,
    totalTracks: album.total_tracks,
    uri: album.uri,
    url: album.external_urls?.spotify,
  };
}

export const getSpotifyProfile = tool(
  async () => {
    try {
      const profile = await spotifyFetch<unknown>('/me');
      return JSON.stringify(profile);
    } catch (error) {
      logger.error('[spotify] getSpotifyProfile', error);
      return `Error fetching Spotify profile: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_profile',
    description: 'Get the authenticated Spotify user profile.',
    schema: z.object({}),
  },
);

export const searchSpotify = tool(
  async ({ query, type, limit }) => {
    try {
      const data = await spotifyFetch<{
        tracks?: { items: unknown[] };
        artists?: { items: unknown[] };
        albums?: { items: unknown[] };
        playlists?: { items: unknown[] };
      }>('/search', {
        query: {
          q: query,
          type: type.join(','),
          limit: limit ?? 5,
        },
      });

      return JSON.stringify({
        tracks: data?.tracks?.items.map(summarizeTrack),
        artists: data?.artists?.items.map(summarizeArtist),
        albums: data?.albums?.items.map(summarizeAlbum),
        playlists: data?.playlists?.items,
      });
    } catch (error) {
      logger.error('[spotify] searchSpotify', error);
      return `Error searching Spotify: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_search',
    description: 'Search Spotify for tracks, artists, albums, or playlists.',
    schema: z.object({
      query: z.string().describe('Spotify search query'),
      type: z
        .array(z.enum(['track', 'artist', 'album', 'playlist']))
        .default(['track'])
        .describe('Item types to search for'),
      limit: z.number().min(1).max(20).optional().describe('Result limit'),
    }),
  },
);

export const getCurrentPlayback = tool(
  async () => {
    try {
      const data = await spotifyFetch<{
        is_playing?: boolean;
        progress_ms?: number;
        device?: unknown;
        item?: unknown;
        context?: unknown;
      }>('/me/player');

      if (!data) return 'No active Spotify playback.';
      return JSON.stringify({
        isPlaying: data.is_playing,
        progressMs: data.progress_ms,
        device: data.device,
        track: summarizeTrack(data.item),
        context: data.context,
      });
    } catch (error) {
      logger.error('[spotify] getCurrentPlayback', error);
      return `Error fetching Spotify playback: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_current_playback',
    description: 'Get the current Spotify playback state and playing track.',
    schema: z.object({}),
  },
);

export const getAvailableDevices = tool(
  async () => {
    try {
      const data = await spotifyFetch<{ devices: unknown[] }>('/me/player/devices');
      return JSON.stringify(data?.devices ?? []);
    } catch (error) {
      logger.error('[spotify] getAvailableDevices', error);
      return `Error fetching Spotify devices: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_available_devices',
    description: 'List Spotify Connect devices available for playback.',
    schema: z.object({}),
  },
);

export const getRecentlyPlayed = tool(
  async ({ limit }) => {
    try {
      const data = await spotifyFetch<{
        items: Array<{ played_at?: string; track?: unknown }>;
      }>('/me/player/recently-played', {
        query: { limit: limit ?? 10 },
      });

      return JSON.stringify(
        data?.items.map((item) => ({
          playedAt: item.played_at,
          track: summarizeTrack(item.track),
        })) ?? [],
      );
    } catch (error) {
      logger.error('[spotify] getRecentlyPlayed', error);
      return `Error fetching recently played tracks: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_recently_played',
    description: 'Get recently played Spotify tracks.',
    schema: z.object({
      limit: z.number().min(1).max(50).optional().describe('Result limit'),
    }),
  },
);

export const getUserPlaylists = tool(
  async ({ limit }) => {
    try {
      const data = await spotifyFetch<{ items: unknown[] }>('/me/playlists', {
        query: { limit: limit ?? 20 },
      });
      return JSON.stringify(data?.items ?? []);
    } catch (error) {
      logger.error('[spotify] getUserPlaylists', error);
      return `Error fetching Spotify playlists: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_user_playlists',
    description: "Get the authenticated user's Spotify playlists.",
    schema: z.object({
      limit: z.number().min(1).max(50).optional().describe('Result limit'),
    }),
  },
);

export const getPlaylistTracks = tool(
  async ({ playlistId, limit }) => {
    try {
      const data = await spotifyFetch<{ items: Array<{ track?: unknown }> }>(
        `/playlists/${encodeURIComponent(playlistId)}/tracks`,
        { query: { limit: limit ?? 50 } },
      );
      return JSON.stringify(
        data?.items.map((item) => summarizeTrack(item.track)) ?? [],
      );
    } catch (error) {
      logger.error('[spotify] getPlaylistTracks', error);
      return `Error fetching Spotify playlist tracks: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_get_playlist_tracks',
    description: 'Get tracks from a Spotify playlist by playlist ID.',
    schema: z.object({
      playlistId: z.string().describe('Spotify playlist ID'),
      limit: z.number().min(1).max(100).optional().describe('Result limit'),
    }),
  },
);

export const startOrResumePlayback = tool(
  async ({ deviceId, contextUri, uris, positionMs }) => {
    try {
      await spotifyFetch('/me/player/play', {
        method: 'PUT',
        query: { device_id: deviceId },
        body: {
          ...(contextUri ? { context_uri: contextUri } : {}),
          ...(uris?.length ? { uris } : {}),
          ...(positionMs !== undefined ? { position_ms: positionMs } : {}),
        },
      });
      return 'Spotify playback started.';
    } catch (error) {
      logger.error('[spotify] startOrResumePlayback', error);
      return `Error starting Spotify playback: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_start_or_resume_playback',
    description:
      'Start or resume Spotify playback. Can play a context URI or a list of track URIs.',
    schema: z.object({
      deviceId: z.string().optional().describe('Spotify device ID'),
      contextUri: z
        .string()
        .optional()
        .describe('Spotify context URI, such as an album or playlist URI'),
      uris: z
        .array(z.string())
        .optional()
        .describe('Spotify track URIs to play'),
      positionMs: z.number().optional().describe('Playback position in ms'),
    }),
  },
);

export const pausePlayback = tool(
  async ({ deviceId }) => {
    try {
      await spotifyFetch('/me/player/pause', {
        method: 'PUT',
        query: { device_id: deviceId },
      });
      return 'Spotify playback paused.';
    } catch (error) {
      logger.error('[spotify] pausePlayback', error);
      return `Error pausing Spotify playback: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_pause_playback',
    description: 'Pause Spotify playback.',
    schema: z.object({
      deviceId: z.string().optional().describe('Spotify device ID'),
    }),
  },
);

export const skipToNext = tool(
  async ({ deviceId }) => {
    try {
      await spotifyFetch('/me/player/next', {
        method: 'POST',
        query: { device_id: deviceId },
      });
      return 'Skipped to the next Spotify track.';
    } catch (error) {
      logger.error('[spotify] skipToNext', error);
      return `Error skipping Spotify track: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_skip_to_next',
    description: 'Skip to the next Spotify track.',
    schema: z.object({
      deviceId: z.string().optional().describe('Spotify device ID'),
    }),
  },
);

export const skipToPrevious = tool(
  async ({ deviceId }) => {
    try {
      await spotifyFetch('/me/player/previous', {
        method: 'POST',
        query: { device_id: deviceId },
      });
      return 'Skipped to the previous Spotify track.';
    } catch (error) {
      logger.error('[spotify] skipToPrevious', error);
      return `Error going to previous Spotify track: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_skip_to_previous',
    description: 'Skip to the previous Spotify track.',
    schema: z.object({
      deviceId: z.string().optional().describe('Spotify device ID'),
    }),
  },
);

export const setPlaybackVolume = tool(
  async ({ volumePercent, deviceId }) => {
    try {
      await spotifyFetch('/me/player/volume', {
        method: 'PUT',
        query: { volume_percent: volumePercent, device_id: deviceId },
      });
      return `Spotify volume set to ${volumePercent}%.`;
    } catch (error) {
      logger.error('[spotify] setPlaybackVolume', error);
      return `Error setting Spotify volume: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_set_playback_volume',
    description: 'Set Spotify playback volume from 0 to 100.',
    schema: z.object({
      volumePercent: z.number().min(0).max(100).describe('Volume percentage'),
      deviceId: z.string().optional().describe('Spotify device ID'),
    }),
  },
);

export const addItemToQueue = tool(
  async ({ uri, deviceId }) => {
    try {
      await spotifyFetch('/me/player/queue', {
        method: 'POST',
        query: { uri, device_id: deviceId },
      });
      return `Added ${uri} to the Spotify queue.`;
    } catch (error) {
      logger.error('[spotify] addItemToQueue', error);
      return `Error adding item to Spotify queue: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'spotify_add_item_to_queue',
    description: 'Add a Spotify track or episode URI to the playback queue.',
    schema: z.object({
      uri: z.string().describe('Spotify track or episode URI'),
      deviceId: z.string().optional().describe('Spotify device ID'),
    }),
  },
);

export const spotifyTools = [
  getSpotifyProfile,
  searchSpotify,
  getCurrentPlayback,
  getAvailableDevices,
  getRecentlyPlayed,
  getUserPlaylists,
  getPlaylistTracks,
  startOrResumePlayback,
  pausePlayback,
  skipToNext,
  skipToPrevious,
  setPlaybackVolume,
  addItemToQueue,
];
