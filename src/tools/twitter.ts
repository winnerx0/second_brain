import { tool } from 'langchain';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getValidToken } from '../oauth.js';

const TWITTER_API_URL = 'https://api.twitter.com/2';
const USER_FIELDS =
  'id,name,username,description,created_at,public_metrics,verified';
const TWEET_FIELDS =
  'id,text,created_at,public_metrics,conversation_id,referenced_tweets,author_id';

type TwitterFetchOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

async function getTwitterToken(): Promise<string> {
  const token = await getValidToken('twitter');
  if (!token) {
    throw new Error(
      'Twitter/X is not connected. Please connect Twitter/X in Connections first.',
    );
  }
  return token;
}

function buildUrl(path: string, query?: TwitterFetchOptions['query']): string {
  const url = new URL(`${TWITTER_API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function twitterFetch<T>(
  path: string,
  options: TwitterFetchOptions = {},
): Promise<T | null> {
  const token = await getTwitterToken();
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
    throw new Error(`Twitter/X API request failed (${res.status}): ${text}`);
  }

  return data as T;
}

export const getTwitterMe = tool(
  async () => {
    try {
      const data = await twitterFetch('/users/me', {
        query: { 'user.fields': USER_FIELDS },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] getTwitterMe', error);
      return `Error fetching Twitter/X profile: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_get_me',
    description: 'Get the authenticated Twitter/X user profile.',
    schema: z.object({}),
  },
);

export const getTwitterUserByUsername = tool(
  async ({ username }) => {
    try {
      const cleanUsername = username.replace(/^@/, '');
      const data = await twitterFetch(
        `/users/by/username/${encodeURIComponent(cleanUsername)}`,
        { query: { 'user.fields': USER_FIELDS } },
      );
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] getTwitterUserByUsername', error);
      return `Error fetching Twitter/X user: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_get_user_by_username',
    description: 'Get a Twitter/X user profile by username.',
    schema: z.object({
      username: z.string().describe('Twitter/X username, with or without @'),
    }),
  },
);

export const getTwitterUserTweets = tool(
  async ({ userId, maxResults }) => {
    try {
      const data = await twitterFetch(`/users/${encodeURIComponent(userId)}/tweets`, {
        query: {
          max_results: maxResults ?? 10,
          'tweet.fields': TWEET_FIELDS,
          expansions: 'author_id',
          'user.fields': USER_FIELDS,
        },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] getTwitterUserTweets', error);
      return `Error fetching Twitter/X posts: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_get_user_tweets',
    description: 'Get recent posts from a Twitter/X user by user ID.',
    schema: z.object({
      userId: z.string().describe('Twitter/X user ID'),
      maxResults: z
        .number()
        .min(5)
        .max(100)
        .optional()
        .describe('Number of posts to fetch'),
    }),
  },
);

export const searchRecentTweets = tool(
  async ({ query, maxResults }) => {
    try {
      const data = await twitterFetch('/tweets/search/recent', {
        query: {
          query,
          max_results: maxResults ?? 10,
          'tweet.fields': TWEET_FIELDS,
          expansions: 'author_id',
          'user.fields': USER_FIELDS,
        },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] searchRecentTweets', error);
      return `Error searching Twitter/X posts: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_search_recent_tweets',
    description: 'Search recent Twitter/X posts.',
    schema: z.object({
      query: z.string().describe('Twitter/X recent search query'),
      maxResults: z
        .number()
        .min(10)
        .max(100)
        .optional()
        .describe('Number of posts to fetch'),
    }),
  },
);

export const getTwitterMentions = tool(
  async ({ userId, maxResults }) => {
    try {
      const data = await twitterFetch(
        `/users/${encodeURIComponent(userId)}/mentions`,
        {
          query: {
            max_results: maxResults ?? 10,
            'tweet.fields': TWEET_FIELDS,
            expansions: 'author_id',
            'user.fields': USER_FIELDS,
          },
        },
      );
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] getTwitterMentions', error);
      return `Error fetching Twitter/X mentions: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_get_mentions',
    description: 'Get recent mentions for a Twitter/X user by user ID.',
    schema: z.object({
      userId: z.string().describe('Twitter/X user ID'),
      maxResults: z
        .number()
        .min(5)
        .max(100)
        .optional()
        .describe('Number of mentions to fetch'),
    }),
  },
);

export const createTweet = tool(
  async ({ text, replyToTweetId }) => {
    try {
      const data = await twitterFetch('/tweets', {
        method: 'POST',
        body: {
          text,
          ...(replyToTweetId
            ? { reply: { in_reply_to_tweet_id: replyToTweetId } }
            : {}),
        },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] createTweet', error);
      return `Error creating Twitter/X post: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_create_tweet',
    description: 'Create a Twitter/X post or reply as the authenticated user.',
    schema: z.object({
      text: z.string().min(1).max(280).describe('Post text'),
      replyToTweetId: z
        .string()
        .optional()
        .describe('Tweet ID to reply to, if creating a reply'),
    }),
  },
);

export const deleteTweet = tool(
  async ({ tweetId }) => {
    try {
      const data = await twitterFetch(`/tweets/${encodeURIComponent(tweetId)}`, {
        method: 'DELETE',
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[twitter] deleteTweet', error);
      return `Error deleting Twitter/X post: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'twitter_delete_tweet',
    description: 'Delete one of the authenticated user Twitter/X posts by ID.',
    schema: z.object({
      tweetId: z.string().describe('Tweet ID to delete'),
    }),
  },
);

export const twitterTools = [
  getTwitterMe,
  getTwitterUserByUsername,
  getTwitterUserTweets,
  searchRecentTweets,
  getTwitterMentions,
  createTweet,
  deleteTweet,
];
