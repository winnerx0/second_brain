import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { tavilyTools } from '../tools/tavily.js';
import { streamSubAgent } from './utils.js';
import { workflowPolicy } from '../workflows/policy.js';

const TAVILY_SYSTEM_PROMPT = `You are a Web Search Assistant with access to Tavily web search.

When helping:
- Use Tavily for live web lookups, recent facts, news, source discovery, and external references.
- Prefer concise queries. Use topic "news" for current events and "finance" for markets or company financial information.
- Use freshness filters when the user asks for latest, recent, today, this week, or another time-sensitive window.
- Always cite the source URLs you used in the final answer.
- Never invent sources or claim a source says something if it was not returned by the search tool.
- If Tavily is not configured or a search fails, report that failure clearly.`;

const tavilyAgent = createAgent({
  model,
  middleware: [workflowPolicy],
  tools: [...tavilyTools],
});

export const tavilyTool = tool(
  async ({ query }) => {
    return streamSubAgent(
      tavilyAgent,
      [
        { role: 'system', content: TAVILY_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'tavily',
    );
  },
  {
    name: 'web_search',
    description:
      'Search the live web with Tavily for current information, recent facts, news, source discovery, or external references.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language web search request (e.g., 'Find the latest React release notes', 'What happened with OpenAI today?', 'Search official docs for Tavily auth')",
        ),
    }),
  },
);
