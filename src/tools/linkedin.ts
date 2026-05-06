import { tool } from 'langchain';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getValidToken } from '../oauth.js';

const LINKEDIN_API_URL = 'https://api.linkedin.com/v2';

type LinkedInFetchOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

async function getLinkedInToken(): Promise<string> {
  const token = await getValidToken('linkedin');
  if (!token) {
    throw new Error(
      'LinkedIn is not connected. Please connect LinkedIn in Connections first.',
    );
  }
  return token;
}

function buildUrl(
  path: string,
  query?: LinkedInFetchOptions['query'],
): string {
  const url = new URL(`${LINKEDIN_API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function linkedInFetch<T>(
  path: string,
  options: LinkedInFetchOptions = {},
): Promise<T | null> {
  const token = await getLinkedInToken();
  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    throw new Error(`LinkedIn API request failed (${res.status}): ${text}`);
  }

  return data as T;
}

export const getLinkedInProfile = tool(
  async () => {
    try {
      const data = await linkedInFetch('/userinfo');
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[linkedin] getLinkedInProfile', error);
      return `Error fetching LinkedIn profile: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'linkedin_get_profile',
    description:
      'Get the authenticated LinkedIn user profile (ID, name, email, picture).',
    schema: z.object({}),
  },
);

export const getLinkedInPosts = tool(
  async ({ personId, maxResults }) => {
    try {
      const data = await linkedInFetch('/ugcPosts', {
        query: {
          q: 'authors',
          authors: `urn:li:person:${personId}`,
          count: maxResults ?? 10,
        },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[linkedin] getLinkedInPosts', error);
      return `Error fetching LinkedIn posts: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'linkedin_get_posts',
    description: 'Get recent LinkedIn posts from the authenticated user.',
    schema: z.object({
      personId: z
        .string()
        .describe('LinkedIn person ID (from userinfo response)'),
      maxResults: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of posts to fetch'),
    }),
  },
);

export const createLinkedInPost = tool(
  async ({ text, visibility, personId }) => {
    try {
      if (!personId) {
        return 'Error: personId is required. Fetch your profile first to get your person ID.';
      }

      const data = await linkedInFetch('/v2/ugcPosts', {
        method: 'POST',
        body: {
          author: `urn:li:person:${personId}`,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: {
                text,
              },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: {
            'com.linkedin.ugc.MemberNetworkVisibility': visibility ?? 'PUBLIC',
          },
        },
      });
      return JSON.stringify(data);
    } catch (error) {
      logger.error('[linkedin] createLinkedInPost', error);
      return `Error creating LinkedIn post: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'linkedin_create_post',
    description: 'Create and publish a LinkedIn post.',
    schema: z.object({
      personId: z.string().describe('LinkedIn person ID (from profile/userinfo)'),
      text: z.string().min(1).describe('Post text (max 3000 characters)'),
      visibility: z
        .enum(['PUBLIC', 'CONNECTIONS'])
        .optional()
        .describe('Visibility level (PUBLIC or CONNECTIONS)'),
    }),
  },
);

export const linkedinTools = [
  getLinkedInProfile,
  getLinkedInPosts,
  createLinkedInPost,
];
