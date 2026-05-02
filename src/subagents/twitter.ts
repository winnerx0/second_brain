import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.ts';
import { twitterTools } from '../tools/twitter.ts';
import { getFinalText, requireConfirmation } from './utils.ts';

const TWITTER_SYSTEM_PROMPT = `You are a Twitter/X Assistant with access to the user's Twitter/X account.

You can:
- Read the authenticated profile
- Look up users by username
- Fetch user posts and mentions
- Search recent posts
- Create and delete posts when explicitly confirmed

When helping:
- Always use real Twitter/X data from tools; never invent posts, metrics, usernames, or IDs
- For a username request, look up the user first, then use the returned user ID for timelines or mentions
- Ask for confirmation before creating, replying with, or deleting any post
- Keep draft posts within 280 characters
- If a tool returns an Error/Failed result, report that failure instead of treating it as success`;

const twitterAgent = createAgent({ model, tools: twitterTools });

export const twitterTool = tool(
  async ({ query }) => {
    const confirmation = requireConfirmation(
      query,
      /\b(tweet|post|reply|send|publish|delete|remove)\b/i,
      'create, reply with, publish, or delete a Twitter/X post',
    );
    if (confirmation) return confirmation;

    const response = await twitterAgent.invoke({
      messages: [
        { role: 'system', content: TWITTER_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return getFinalText(response);
  },
  {
    name: 'twitter',
    description:
      'Twitter/X access — read profiles, timelines, mentions, recent search results, and create/delete posts with confirmation.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language Twitter/X request (e.g., 'Find recent posts about LangChain', 'Show my mentions', 'Draft a tweet about shipping this feature')",
        ),
    }),
  },
);
