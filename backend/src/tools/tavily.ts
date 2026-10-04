import { tool } from 'langchain';
import z from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
};

type TavilySearchResponse = {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
  response_time?: number | string;
  usage?: {
    credits?: number;
  };
  request_id?: string;
};

const searchDepthSchema = z
  .enum(['basic', 'advanced', 'fast', 'ultra-fast'])
  .default('basic');

const topicSchema = z.enum(['general', 'news', 'finance']).default('general');

export const tavilySearch = tool(
  async ({
    query,
    search_depth,
    topic,
    max_results,
    time_range,
    include_domains,
    exclude_domains,
  }) => {
    if (!config.TAVILY_API_KEY) {
      return 'Tavily web search is not configured. Set TAVILY_API_KEY in the environment, then restart the app.';
    }

    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.TAVILY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          search_depth,
          topic,
          max_results,
          include_answer: 'basic',
          include_usage: true,
          include_favicon: true,
          ...(time_range ? { time_range } : {}),
          ...(include_domains?.length ? { include_domains } : {}),
          ...(exclude_domains?.length ? { exclude_domains } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        return `Tavily search failed (${res.status}): ${err}`;
      }

      const data = (await res.json()) as TavilySearchResponse;

      return JSON.stringify({
        query: data.query ?? query,
        answer: data.answer,
        results: (data.results ?? []).map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          rawContent: result.raw_content,
          score: result.score,
          publishedDate: result.published_date,
        })),
        responseTime: data.response_time,
        creditsUsed: data.usage?.credits,
        requestId: data.request_id,
      });
    } catch (error) {
      logger.error('[tavily]', error);
      return `Error searching Tavily: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: 'tavily_search',
    description:
      'Search the live web using Tavily. Use this for current events, recent facts, external sources, and web lookups.',
    schema: z.object({
      query: z.string().describe('The web search query to execute.'),
      search_depth: searchDepthSchema.describe(
        'Latency/relevance tradeoff. basic is the default; advanced costs more but can improve detailed queries.',
      ),
      topic: topicSchema.describe(
        'Search category. Use news for current news, finance for finance queries, and general otherwise.',
      ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Maximum number of results to return.'),
      time_range: z
        .enum(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'])
        .optional()
        .describe('Optional freshness filter based on publish or update date.'),
      include_domains: z
        .array(z.string())
        .optional()
        .describe('Optional list of domains to limit results to.'),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe('Optional list of domains to exclude from results.'),
    }),
  },
);

export const tavilyTools = [tavilySearch];
