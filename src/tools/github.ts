import { tool } from 'langchain';
import { z } from 'zod';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { getValidToken } from '../oauth.ts';

async function getGitHubToken(): Promise<string> {
  const token = await getValidToken('github');
  if (token) return token;
  return config.GITHUB_TOKEN;
}

const getHeaders = async () => ({
  Authorization: `Bearer ${await getGitHubToken()}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'second-brain-agent',
});

interface SearchItem {
  title: string;
  html_url: string;
  repository_url: string;
  created_at: string;
}

interface EventItem {
  type: string;
  repo: { name: string };
  created_at: string;
  payload: {
    commits?: Array<{ message: string }>;
    size?: number;
    head?: string;
    before?: string;
    ref?: string;
  };
}

export const getOpenPRs = tool(
  async () => {
    try {
      const res = await fetch(
        `https://api.github.com/search/issues?q=author:${config.GITHUB_USERNAME}+type:pr+state:open`,
        { headers: await getHeaders() },
      );
      const data = (await res.json()) as {
        items?: SearchItem[];
      };
      const items = data.items ?? [];
      return JSON.stringify(
        items.map((item) => ({
          title: item.title,
          repo: item.repository_url.split('/').slice(-2).join('/'),
          createdAt: item.created_at,
          url: item.html_url,
        })),
      );
    } catch (error) {
      logger.error('[github]', error);
      return `Error fetching open PRs: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_open_prs',
    description:
      'Get all open pull requests authored by the user across all repos.',
    schema: z.object({}),
  },
);

export const getAssignedIssues = tool(
  async () => {
    try {
      const res = await fetch(
        `https://api.github.com/search/issues?q=is:issue+assignee:${config.GITHUB_USERNAME}+state:open`,
        { headers: await getHeaders() },
      );
      const data = (await res.json()) as {
        items?: SearchItem[];
      };

      logger.info(
        `[github] fetched ${data.items?.length ?? 0} assigned issues`,
      );
      const items = data.items ?? [];
      return JSON.stringify(
        items.map((item) => ({
          title: item.title,
          repo: item.repository_url.split('/').slice(-2).join('/'),
          createdAt: item.created_at,
          url: item.html_url,
        })),
      );
    } catch (error) {
      logger.error('[github]', error);
      return `Error fetching assigned issues: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_assigned_issues',
    description: 'Get all open issues assigned to the user.',
    schema: z.object({}),
  },
);

export const getRecentPushes = tool(
  async () => {
    try {
      const headers = await getHeaders();
      const res = await fetch(
        `https://api.github.com/users/${config.GITHUB_USERNAME}/events?per_page=100`,
        { headers },
      );
      const events = (await res.json()) as EventItem[];
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const pushEvents = events.filter(
        (e) => e.type === 'PushEvent' && new Date(e.created_at) > oneDayAgo,
      );

      const pushes = await Promise.all(
        pushEvents.map(async (e) => {
          let commits: string[] =
            e.payload.commits?.map((c) => c.message) ?? [];

          if (commits.length === 0 && e.payload.head && e.payload.before) {
            try {
              const compareRes = await fetch(
                `https://api.github.com/repos/${e.repo.name}/compare/${e.payload.before}...${e.payload.head}`,
                {
                  headers,
                },
              );
              const compareData = (await compareRes.json()) as {
                commits?: Array<{
                  commit: {
                    message: string;
                  };
                }>;
              };
              commits = compareData.commits?.map((c) => c.commit.message) ?? [];
            } catch {
              // keep empty
            }
          }

          return {
            repo: e.repo.name,
            pushedAt: e.created_at,
            commitCount: e.payload.size ?? commits.length,
            commits,
          };
        }),
      );

      return JSON.stringify(pushes);
    } catch (error) {
      logger.error('[github]', error);
      return `Error fetching recent pushes: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_recent_pushes',
    description:
      'Get repos the user pushed to in the last 24 hours, with commit counts and commit messages.',
    schema: z.object({}),
  },
);

export const createIssue = tool(
  async ({ repo, title, body, labels, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/issues`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            ...(body ? { body } : {}),
            ...(labels?.length ? { labels } : {}),
            assignees: [config.GITHUB_USERNAME],
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to create issue (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        html_url: string;
        number: number;
      };
      return `Issue #${data.number} created: ${data.html_url}`;
    } catch (error) {
      logger.error('[github]', error);
      return `Error creating issue: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_issue',
    description:
      'Open a new GitHub issue on a specified repository. Owner defaults to the authenticated user.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      title: z.string().describe('Issue title'),
      body: z
        .string()
        .optional()
        .describe('Issue body / description (markdown)'),
      labels: z
        .array(z.string())
        .optional()
        .describe('Labels to apply (e.g. ["bug", "enhancement"])'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const closeIssue = tool(
  async ({ repo, issue_number, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/issues/${issue_number}`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state: 'closed',
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to close issue (${res.status}): ${err}`;
      }

      return `Issue #${issue_number} in ${repoOwner}/${repo} closed.`;
    } catch (error) {
      logger.error('[github]', error);
      return `Error closing issue: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'close_issue',
    description:
      'Close an open GitHub issue by number. If you do not already have the issue number, call get_assigned_issues first to retrieve it.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      issue_number: z.number().describe('Issue number to close'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const deleteIssue = tool(
  async ({ repo, issue_number, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();

      // Resolve the node ID first (GraphQL requires the global node ID, not the issue number)
      const idRes = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/issues/${issue_number}`,
        { headers },
      );

      if (!idRes.ok)
        return `Issue #${issue_number} not found in ${repoOwner}/${repo}.`;

      const issueData = (await idRes.json()) as {
        node_id: string;
      };
      const nodeId = issueData.node_id;

      const delRes = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation { deleteIssue(input: { issueId: "${nodeId}" }) { repository { name } } }`,
        }),
      });

      const delData = (await delRes.json()) as {
        errors?: Array<{ message: string }>;
      };
      if (delData.errors?.length)
        return `GraphQL error: ${delData.errors[0]!.message}`;

      return `Issue #${issue_number} in ${repoOwner}/${repo} deleted.`;
    } catch (error) {
      logger.error('[github]', error);
      return `Error deleting issue: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'delete_issue',
    description:
      'Permanently delete a GitHub issue by number. Requires admin access on the repository. If you do not already have the issue number, call get_assigned_issues first to retrieve it.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      issue_number: z.number().describe('Issue number to delete'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const githubTools = [
  getOpenPRs,
  getAssignedIssues,
  getRecentPushes,
  createIssue,
  closeIssue,
  deleteIssue,
];
