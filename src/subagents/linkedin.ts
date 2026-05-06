import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { linkedinTools } from '../tools/linkedin.js';
import { streamSubAgent } from './utils.js';

const LINKEDIN_SYSTEM_PROMPT = `You are a LinkedIn Assistant with access to the user's LinkedIn account.

You can:
- Get the user's profile (ID, name, email, profile picture)
- Fetch recent posts from the user's timeline
- Create and publish posts

When helping:
- Always use real data from tools, never guess or fabricate
- If a tool returns an error or failed result, report that failure instead of treating it as success
- When creating posts, keep text concise and engaging
- Always get the person ID from the profile when needed for creating posts
- LinkedIn's API only supports creating PUBLISHED posts (no drafts)`;

const linkedinAgent = createAgent({
  model,
  tools: linkedinTools,
});

export const linkedinTool = tool(
  async ({ query }) => {
    return streamSubAgent(
      linkedinAgent,
      [
        { role: 'system', content: LINKEDIN_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'linkedin',
    );
  },
  {
    name: 'linkedin',
    description:
      'Manage LinkedIn — read profile, get/create/update/delete posts, create and publish drafts.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language LinkedIn request (e.g., 'Get my profile', 'Create a post saying...', 'Delete my last post')",
        ),
    }),
  },
);
