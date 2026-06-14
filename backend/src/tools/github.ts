import { tool } from 'langchain';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getValidToken } from '../oauth.js';

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

export const createPullRequest = tool(
  async ({ repo, title, head, base, body, draft, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();

      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/pulls`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            head,
            base,
            ...(body ? { body } : {}),
            ...(draft !== undefined ? { draft } : {}),
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to create pull request (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        html_url: string;
        number: number;
        title: string;
        state: string;
        draft?: boolean;
      };

      return JSON.stringify({
        message: `Pull request #${data.number} created.`,
        number: data.number,
        title: data.title,
        state: data.state,
        draft: data.draft ?? false,
        url: data.html_url,
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error creating pull request: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: 'create_pull_request',
    description:
      'Create a GitHub pull request from a head branch into a base branch. Use this after code has already been pushed to GitHub.',
    schema: z.object({
      repo: z.string().describe('Repository name, e.g. "kron"'),
      title: z.string().describe('Pull request title'),
      head: z
        .string()
        .describe(
          'The branch containing changes. Example: "feature/jobs" or "winnerx0:feature/jobs" for forks.',
        ),
      base: z
        .string()
        .default('main')
        .describe('The branch to merge into, usually "main" or "master".'),
      body: z
        .string()
        .optional()
        .describe('Pull request body / description in markdown.'),
      draft: z
        .boolean()
        .optional()
        .describe('Whether to create the pull request as a draft.'),
      owner: z
        .string()
        .optional()
        .describe('Repository owner. Omit to use your own username.'),
    }),
  },
);

export const getPullRequest = tool(
  async ({ repo, pull_number, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();

      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/pulls/${pull_number}`,
        { headers },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to get pull request (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        number: number;
        title: string;
        state: string;
        draft: boolean;
        html_url: string;
        mergeable: boolean | null;
        mergeable_state?: string;
        merged: boolean;
        base: { ref: string };
        head: { ref: string; sha: string };
        user?: { login: string };
      };

      return JSON.stringify({
        number: data.number,
        title: data.title,
        state: data.state,
        draft: data.draft,
        merged: data.merged,
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        base: data.base.ref,
        head: data.head.ref,
        headSha: data.head.sha,
        author: data.user?.login,
        url: data.html_url,
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error fetching pull request: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: 'get_pull_request',
    description:
      'Get details about a GitHub pull request, including mergeability, branch names, state, and URL.',
    schema: z.object({
      repo: z.string().describe('Repository name, e.g. "kron"'),
      pull_number: z.number().describe('Pull request number'),
      owner: z
        .string()
        .optional()
        .describe('Repository owner. Omit to use your own username.'),
    }),
  },
);

export const mergePullRequest = tool(
  async ({
    repo,
    pull_number,
    commit_title,
    commit_message,
    merge_method,
    expected_head_sha,
    owner,
  }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();

      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/pulls/${pull_number}/merge`,
        {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(commit_title ? { commit_title } : {}),
            ...(commit_message ? { commit_message } : {}),
            ...(merge_method ? { merge_method } : {}),
            ...(expected_head_sha ? { sha: expected_head_sha } : {}),
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to merge pull request (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        sha: string;
        merged: boolean;
        message: string;
      };

      return JSON.stringify({
        message: data.message,
        merged: data.merged,
        sha: data.sha,
        pullNumber: pull_number,
        repo: `${repoOwner}/${repo}`,
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error merging pull request: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: 'merge_pull_request',
    description:
      'Merge an open GitHub pull request by number. If unsure whether it is mergeable, call get_pull_request first.',
    schema: z.object({
      repo: z.string().describe('Repository name, e.g. "kron"'),
      pull_number: z.number().describe('Pull request number to merge'),
      commit_title: z
        .string()
        .optional()
        .describe('Custom merge commit title.'),
      commit_message: z
        .string()
        .optional()
        .describe('Custom merge commit message.'),
      merge_method: z
        .enum(['merge', 'squash', 'rebase'])
        .optional()
        .describe(
          'Merge strategy. Use "merge", "squash", or "rebase". Defaults to the repository default if omitted.',
        ),
      expected_head_sha: z
        .string()
        .optional()
        .describe(
          'Optional expected head SHA. This prevents merging if the PR changed after it was checked.',
        ),
      owner: z
        .string()
        .optional()
        .describe('Repository owner. Omit to use your own username.'),
    }),
  },
);

interface CommitSearchItem {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  repository: { full_name: string };
  author?: { login: string };
}

export const getCommits = tool(
  async ({ from, to, repo, owner, author }) => {
    try {
      const commitAuthor = author ?? config.GITHUB_USERNAME;
      const qualifiers = [`author:${commitAuthor}`];

      if (from || to) {
        // GitHub's author-date qualifier accepts open-ended ranges with "*".
        const start = from ?? '*';
        const end = to ?? '*';
        qualifiers.push(`author-date:${start}..${end}`);
      }

      if (repo) {
        const repoOwner = owner ?? config.GITHUB_USERNAME;
        qualifiers.push(`repo:${repoOwner}/${repo}`);
      }

      const query = encodeURIComponent(qualifiers.join(' '));
      const res = await fetch(
        `https://api.github.com/search/commits?q=${query}&sort=author-date&order=desc&per_page=100`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to fetch commits (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        total_count?: number;
        items?: CommitSearchItem[];
      };

      const items = data.items ?? [];
      logger.info(
        `[github] fetched ${items.length} commits (total ${data.total_count ?? 0})`,
      );

      return JSON.stringify({
        totalCount: data.total_count ?? items.length,
        commits: items.map((item) => ({
          sha: item.sha.slice(0, 7),
          message: item.commit.message,
          repo: item.repository.full_name,
          author: item.author?.login ?? item.commit.author.name,
          date: item.commit.author.date,
          url: item.html_url,
        })),
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error fetching commits: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
  {
    name: 'get_commits',
    description:
      'Get commits authored by the user within a date/time range, optionally scoped to a single repo. Returns up to 100 commits, newest first.',
    schema: z.object({
      from: z
        .string()
        .optional()
        .describe(
          'Start of the range (inclusive) as an ISO 8601 date or datetime, e.g. "2026-06-01" or "2026-06-01T09:00:00+00:00". Omit for no lower bound.',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'End of the range (inclusive) as an ISO 8601 date or datetime, e.g. "2026-06-14" or "2026-06-14T17:30:00+00:00". Omit for no upper bound.',
        ),
      repo: z
        .string()
        .optional()
        .describe('Repository name to scope to (e.g. "second-brain"). Omit to search all repos.'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — only used with "repo". Omit to use your own username.'),
      author: z
        .string()
        .optional()
        .describe('Commit author username. Omit to use your own username.'),
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
  createPullRequest,
  getPullRequest,
  mergePullRequest,
  getCommits,
];
