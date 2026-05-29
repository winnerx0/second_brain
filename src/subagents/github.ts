import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import {
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
} from '../tools/github.js';
import { streamSubAgent } from './utils.js';

const GITHUB_SYSTEM_PROMPT = `You are a GitHub Assistant with access to the user's GitHub account.

You can:
- Fetch open pull requests, assigned issues, and recent pushes
- Create, close, and delete issues
- Read content: list/inspect repositories, read files and directories, read full issue and pull request content (bodies, diffs, comments), and list or inspect commits with their diffs

When helping:
- Always use real data from tools, never guess or fabricate
- For destructive operations (close, delete), identify the correct repo and issue number, then ask for confirmation before acting
- If a tool returns an Error/Failed result, report that failure instead of treating it as success
- Return concise, structured summaries of results`;

const githubAgent = createAgent({
  model,
  tools: [
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
  ],
});

export const githubTool = tool(
  async ({ query }) => {
    return streamSubAgent(
      githubAgent,
      [
        { role: 'system', content: GITHUB_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'github',
    );
  },
  {
    name: 'github',
    description:
      'Fetch GitHub data (open PRs, assigned issues, recent pushes), read content (repos, files, issue/PR content, commits and their diffs), or manage issues and pull requests (create, close, delete, merge).',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for GitHub operations (e.g., 'List my open PRs', 'Show the README of second-brain', 'What's in issue #3?', 'Summarize the changes in PR #24', 'Show the last 5 commits on main')",
        ),
    }),
  },
);
