import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { notionTools } from '../tools/notion.js';
import { streamSubAgent } from './utils.js';

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with full access to the user's Notion workspace via the OAuth API.

How to work correctly:
- Use the provided tools to search, read, create, and update Notion content.
- Always search first before creating pages to avoid duplicates.
- For "that page" or vague references, search first.
- When creating content, structure it logically using the available blocks.
- READ database schemas first to understand property names before querying or adding rows.
- Ask for confirmation before trashing pages, deleting blocks, or making broad replacements.
- If a tool returns an Error/Failed result, report that failure instead of treating it as success.`;

const notionAgent = createAgent({
  model,
  tools: [...notionTools],
});

export const notionTool = tool(
  async ({ query }) => {
    return streamSubAgent(
      notionAgent,
      [
        { role: 'system', content: NOTION_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'notion',
    );
  },
  {
    name: 'notion',
    description:
      'Full Notion workspace access — search, read, create, and edit pages, databases, blocks, and comments.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Notion operations (e.g., 'Find my project notes', 'Create a new page called Meeting Notes', 'Add a row to my Tasks database')",
        ),
    }),
  },
);
