import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { spotifyTools } from '../tools/spotify.js';
import { getFinalText } from './utils.js';

const SPOTIFY_SYSTEM_PROMPT = `You are a Spotify Assistant with access to the user's Spotify account.

You can:
- Read current playback, devices, recently played tracks, playlists, and playlist tracks
- Search for tracks, artists, albums, and playlists
- Start, pause, skip, set volume, and add items to the queue

When helping:
- Always use real Spotify data from tools; never invent track, artist, playlist, or device details
- Resolve track/album/playlist names to Spotify URIs before playback or queue actions
- If playback fails because there is no active device, list available devices and explain that Spotify needs an active device
- Keep responses concise and include track/artist names when reporting playback changes
- If a tool returns an Error/Failed result, report that failure instead of treating it as success`;

const spotifyAgent = createAgent({ model, tools: spotifyTools });

export const spotifyTool = tool(
  async ({ query }) => {
    const response = await spotifyAgent.invoke({
      messages: [
        { role: 'system', content: SPOTIFY_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return getFinalText(response);
  },
  {
    name: 'spotify',
    description:
      'Spotify access — search music, inspect playback/devices/playlists/recent listening, and control playback.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language Spotify request (e.g., 'What is playing?', 'Play Blinding Lights', 'Add this track to queue', 'Show my recent songs')",
        ),
    }),
  },
);
