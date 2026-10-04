import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import {
  getOpenPRs,
  getAssignedIssues,
  getCommits,
  createIssue,
  closeIssue,
  deleteIssue,
  createPullRequest,
  getPullRequest,
  mergePullRequest,
} from '../tools/github.js';
import { streamSubAgent } from './utils.js';
import { workflowPolicy } from '../workflows/policy.js';

const GITHUB_SYSTEM_PROMPT = `You are a GitHub Assistant with access to the user's GitHub account.

You can:
- Fetch open pull requests, assigned issues, and commits (with full messages) in any date/time range — defaults to the last 24 hours
- Create, close, and delete issues

When helping:
- Always use real data from tools, never guess or fabricate
- For destructive operations (close, delete), identify the correct repo and issue number, then ask for confirmation before acting
- If a tool returns an Error/Failed result, report that failure instead of treating it as success
- Return concise, structured summaries of results`;

const githubAgent = createAgent({
  model,
  middleware: [workflowPolicy],
  tools: [
    getOpenPRs,
    getAssignedIssues,
    getCommits,
    createIssue,
    closeIssue,
    deleteIssue,
    createPullRequest,
    getPullRequest,
    mergePullRequest,
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
      'Fetch GitHub data (open PRs, assigned issues, commits in any date/time range) or manage issues (create, close, delete).',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for GitHub operations (e.g., 'List my open PRs', 'Create an issue in second-brain titled Fix login bug', 'What did I push today?')",
        ),
    }),
  },
);
