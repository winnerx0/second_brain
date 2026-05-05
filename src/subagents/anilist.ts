import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { addListEntry, anilistTools } from '../tools/anilist.js';
import { streamSubAgent } from './utils.js';

const STATUS_VALUES = [
  'CURRENT',
  'PLANNING',
  'COMPLETED',
  'DROPPED',
  'PAUSED',
  'REPEATING',
] as const;

type AniListStatus = (typeof STATUS_VALUES)[number];

function extractDirectRatingUpdate(query: string): {
  mediaId: number;
  score: number;
  status?: AniListStatus;
  progress?: number;
} | null {
  const mediaIdMatch = query.match(/(?:media\s*id|id)\s*[:#-]?\s*(\d+)/i);
  if (!mediaIdMatch) return null;

  const scoreMatch =
    query.match(/(\d+(?:\.\d+)?)\s*\/\s*10/i) ??
    query.match(/(?:score|rating)\s*(?:to|=)?\s*(\d+(?:\.\d+)?)/i);
  if (!scoreMatch) return null;

  const mediaId = Number(mediaIdMatch[1]);
  const score = Number(scoreMatch[1]);
  if (!Number.isFinite(mediaId) || !Number.isFinite(score)) return null;

  const upper = query.toUpperCase();
  const status = STATUS_VALUES.find((v) => upper.includes(v));
  const progressMatch = query.match(
    /(?:progress|watched|read)\s*(?:to|=)?\s*(\d+)/i,
  );
  const progress = progressMatch ? Number(progressMatch[1]) : undefined;

  return { mediaId, score, status, progress };
}

const ANILIST_SYSTEM_PROMPT = `You are an Anime & Manga Guide with access to AniList.

When helping users:
- Search for anime/manga by title, genre, or themes
- Provide accurate information: episode counts, airing status, scores, descriptions
- For account actions (rating/list updates), perform the action directly with AniList tools when possible
- If a user says "update my rating" and gives a title, resolve the title to mediaId first, then update the entry
- If required details are genuinely missing (e.g., ambiguous title), ask exactly one concise clarifying question
- Respect spoiler boundaries — never reveal plot twists or major developments
- Keep responses focused on what was asked (synopsis, recommendations, current status)
- If multiple matches exist, present the most popular/relevant one with a brief note
- When the query is vague, ask one clarifying question before proceeding
- If a tool returns an Error/Failed result, report that failure instead of treating it as success`;

const anilistAgent = createAgent({ model, tools: anilistTools });

export const anilistTool = tool(
  async ({ query }) => {
    const directUpdate = extractDirectRatingUpdate(query);
    if (directUpdate) {
      const result = await addListEntry.invoke({
        mediaId: directUpdate.mediaId,
        score: directUpdate.score,
        status: directUpdate.status,
        progress: directUpdate.progress,
      });
      return `Updated your AniList entry (mediaId ${directUpdate.mediaId}) to ${directUpdate.score}/10.${directUpdate.status ? ` Status: ${directUpdate.status}.` : ''}\n${typeof result === 'string' ? result : JSON.stringify(result)}`;
    }

    return streamSubAgent(
      anilistAgent,
      [
        { role: 'system', content: ANILIST_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'anilist',
    );
  },
  {
    name: 'anilist',
    description:
      'Search anime/manga and manage authenticated AniList list actions, including rating updates, status changes, and progress updates.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language query for anime or manga info (e.g., 'What's the rating of Attack on Titan?', 'How many episodes of JJK are out?', 'Update my rating for One Piece to 9/10')",
        ),
    }),
  },
);
