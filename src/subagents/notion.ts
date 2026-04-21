import { createAgent, tool } from 'langchain';
import { model } from '../shared';
import { notionTools } from '../tools/notion';
import { getCurrentDateTime } from '../tools/miscellaneous';
import z from 'zod';
import { logger } from '../logger';

const NOTION_SYSTEM_PROMPT = `You are a Notion Workspace Assistant with full access to the user's Notion workspace via the OAuth API.

How to work correctly:
- Use the provided tools to search, read, create, and update Notion content.
- Always search first before creating pages to avoid duplicates.
- For "that page" or vague references, search first.
- When creating content, structure it logically using the available blocks.
- READ database schemas first to understand property names before querying or adding rows.
- Use get_current_datetime when any date/time context is needed.`;

let _notionAgent: ReturnType<typeof createAgent> | null = null;

async function getAgent() {
  if (!_notionAgent) {
    _notionAgent = createAgent({
      model,
      tools: [getCurrentDateTime, ...notionTools],
    });
  }
  return _notionAgent;
}

export const notionTool = tool(
  async ({ query }) => {
    logger.info(`[notion-tool] ← INVOKED: ${query}`);
    try {
      const agent = await getAgent();
      logger.info(`[notion-tool] agent created`);

      const response = await agent.invoke({
        messages: [
          { role: 'system', content: NOTION_SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
      });

      logger.info(`[notion-tool] agent responded`);

      return response.messages[response.messages.length - 1]!.text;
    } catch (err) {
      logger.error(`[notion-tool] THREW: ${err instanceof Error ? err.stack : String(err)}`);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'notion',
    description:
      'Full Notion workspace access — search, read, create, and edit pages, databases, blocks, and comments.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for Notion operations (e.g., 'Create a meeting notes page', 'Add a task to my Sprint board', 'Find my project tracker database', 'List all Done items in my todo database')",
        ),
    }),
  },
);
