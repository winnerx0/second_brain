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

const MAX_PATCH_LENGTH = 6000;
const MAX_FILE_LENGTH = 50000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated, ${text.length - max} more characters]`;
}

interface RepoSummary {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  language: string | null;
  default_branch: string;
  updated_at: string;
  html_url: string;
}

interface CommitListItem {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  author: { login: string } | null;
  html_url: string;
}

interface CommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface IssueComment {
  user: { login: string } | null;
  body: string;
}

export const listRepos = tool(
  async ({ limit }) => {
    try {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=${limit ?? 30}&sort=updated&affiliation=owner,collaborator`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to list repos (${res.status}): ${err}`;
      }

      const data = (await res.json()) as RepoSummary[];
      return JSON.stringify(
        data.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          description: r.description,
          language: r.language,
          defaultBranch: r.default_branch,
          updatedAt: r.updated_at,
          url: r.html_url,
        })),
      );
    } catch (error) {
      logger.error('[github]', error);
      return `Error listing repos: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'list_repos',
    description:
      'List repositories the user owns or collaborates on, most recently updated first.',
    schema: z.object({
      limit: z
        .number()
        .optional()
        .describe('Max number of repos to return (default 30).'),
    }),
  },
);

export const getRepo = tool(
  async ({ repo, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to get repo (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        full_name: string;
        description: string | null;
        language: string | null;
        default_branch: string;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        topics?: string[];
        visibility?: string;
        html_url: string;
      };

      return JSON.stringify({
        fullName: data.full_name,
        description: data.description,
        language: data.language,
        defaultBranch: data.default_branch,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        topics: data.topics ?? [],
        visibility: data.visibility,
        url: data.html_url,
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error getting repo: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_repo',
    description:
      'Get metadata about a repository: description, default branch, language, star/fork/issue counts, topics, and URL.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const getFileContent = tool(
  async ({ repo, path, ref, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/contents/${path ?? ''}${query}`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to get content (${res.status}): ${err}`;
      }

      const data = (await res.json()) as
        | Array<{ name: string; path: string; type: string }>
        | {
            name: string;
            path: string;
            type: string;
            size: number;
            encoding?: string;
            content?: string;
          };

      // Directory listing
      if (Array.isArray(data)) {
        return JSON.stringify({
          type: 'directory',
          path: path ?? '',
          entries: data.map((e) => ({
            name: e.name,
            path: e.path,
            type: e.type,
          })),
        });
      }

      if (data.type !== 'file' || data.encoding !== 'base64' || !data.content) {
        return `Path "${data.path}" is a ${data.type}, not a readable file.`;
      }

      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      return JSON.stringify({
        type: 'file',
        path: data.path,
        size: data.size,
        content: truncate(decoded, MAX_FILE_LENGTH),
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error getting file content: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_file_content',
    description:
      'Read the content of a file in a repository, or list a directory. Omit path for the repo root. Returns decoded UTF-8 text for files, or entry names for directories.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      path: z
        .string()
        .optional()
        .describe('File or directory path (e.g. "src/index.ts"). Omit for root.'),
      ref: z
        .string()
        .optional()
        .describe('Branch, tag, or commit SHA. Omit for the default branch.'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const getIssue = tool(
  async ({ repo, issue_number, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();

      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/issues/${issue_number}`,
        { headers },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to get issue (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        title: string;
        state: string;
        body: string | null;
        user: { login: string } | null;
        labels: Array<{ name: string } | string>;
        comments: number;
        html_url: string;
      };

      let comments: IssueComment[] = [];
      if (data.comments > 0) {
        const commentsRes = await fetch(
          `https://api.github.com/repos/${repoOwner}/${repo}/issues/${issue_number}/comments`,
          { headers },
        );
        if (commentsRes.ok) {
          comments = (await commentsRes.json()) as IssueComment[];
        }
      }

      return JSON.stringify({
        number: issue_number,
        title: data.title,
        state: data.state,
        author: data.user?.login,
        labels: data.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        body: data.body,
        url: data.html_url,
        comments: comments.map((c) => ({
          author: c.user?.login,
          body: c.body,
        })),
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error getting issue: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_issue',
    description:
      'Get the full content of a GitHub issue by number: title, state, body, labels, author, and all comments.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      issue_number: z.number().describe('Issue number'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const getPullRequestContent = tool(
  async ({ repo, pull_number, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const headers = await getHeaders();
      const base = `https://api.github.com/repos/${repoOwner}/${repo}/pulls/${pull_number}`;

      const prRes = await fetch(base, { headers });
      if (!prRes.ok) {
        const err = await prRes.text();
        return `Failed to get pull request (${prRes.status}): ${err}`;
      }

      const pr = (await prRes.json()) as {
        title: string;
        state: string;
        body: string | null;
        user: { login: string } | null;
        html_url: string;
      };

      const [filesRes, commentsRes] = await Promise.all([
        fetch(`${base}/files?per_page=100`, { headers }),
        fetch(`${base}/comments?per_page=100`, { headers }),
      ]);

      const files = filesRes.ok
        ? ((await filesRes.json()) as CommitFile[])
        : [];
      const comments = commentsRes.ok
        ? ((await commentsRes.json()) as Array<{
            user: { login: string } | null;
            path?: string;
            body: string;
          }>)
        : [];

      return JSON.stringify({
        number: pull_number,
        title: pr.title,
        state: pr.state,
        author: pr.user?.login,
        body: pr.body,
        url: pr.html_url,
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ? truncate(f.patch, MAX_PATCH_LENGTH) : undefined,
        })),
        reviewComments: comments.map((c) => ({
          author: c.user?.login,
          path: c.path,
          body: c.body,
        })),
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error getting pull request content: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_pull_request_content',
    description:
      'Get the content of a pull request: body, changed files with diffs, and review comments. Use get_pull_request for mergeability/state metadata.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      pull_number: z.number().describe('Pull request number'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const listCommits = tool(
  async ({ repo, branch, limit, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const shaQuery = branch ? `&sha=${encodeURIComponent(branch)}` : '';
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/commits?per_page=${limit ?? 20}${shaQuery}`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to list commits (${res.status}): ${err}`;
      }

      const data = (await res.json()) as CommitListItem[];
      return JSON.stringify(
        data.map((c) => ({
          sha: c.sha,
          message: c.commit.message.split('\n')[0],
          author: c.author?.login ?? c.commit.author?.name,
          date: c.commit.author?.date,
          url: c.html_url,
        })),
      );
    } catch (error) {
      logger.error('[github]', error);
      return `Error listing commits: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'list_commits',
    description:
      'List recent commits for a repository (optionally on a specific branch), newest first.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      branch: z
        .string()
        .optional()
        .describe('Branch, tag, or SHA to list from. Omit for the default branch.'),
      limit: z
        .number()
        .optional()
        .describe('Max number of commits to return (default 20).'),
      owner: z
        .string()
        .optional()
        .describe('Repo owner — omit to use your own username'),
    }),
  },
);

export const getCommit = tool(
  async ({ repo, ref, owner }) => {
    try {
      const repoOwner = owner ?? config.GITHUB_USERNAME;
      const res = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repo}/commits/${encodeURIComponent(ref)}`,
        { headers: await getHeaders() },
      );

      if (!res.ok) {
        const err = await res.text();
        return `Failed to get commit (${res.status}): ${err}`;
      }

      const data = (await res.json()) as {
        sha: string;
        commit: {
          message: string;
          author: { name: string; date: string } | null;
        };
        author: { login: string } | null;
        stats?: { additions: number; deletions: number; total: number };
        files?: CommitFile[];
        html_url: string;
      };

      return JSON.stringify({
        sha: data.sha,
        message: data.commit.message,
        author: data.author?.login ?? data.commit.author?.name,
        date: data.commit.author?.date,
        stats: data.stats,
        url: data.html_url,
        files: (data.files ?? []).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ? truncate(f.patch, MAX_PATCH_LENGTH) : undefined,
        })),
      });
    } catch (error) {
      logger.error('[github]', error);
      return `Error getting commit: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_commit',
    description:
      'Get the full content of a single commit: message, author, change stats, and per-file diffs.',
    schema: z.object({
      repo: z.string().describe('Repository name (e.g. "second-brain")'),
      ref: z.string().describe('Commit SHA, branch, or tag'),
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
  createPullRequest,
  getPullRequest,
  mergePullRequest,
  listRepos,
  getRepo,
  getFileContent,
  getIssue,
  getPullRequestContent,
  listCommits,
  getCommit,
];
