import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared';
import {
  getOpenPRs,
  getAssignedIssues,
  getRecentPushes,
  createIssue,
  closeIssue,
  deleteIssue,
} from '../tools/github';

const GITHUB_SYSTEM_PROMPT = `You are a GitHub Assistant with access to the user's GitHub account.

You can:
- Fetch open pull requests, assigned issues, and recent pushes
- Create, close, and delete issues

When helping:
- Always use real data from tools, never guess or fabricate
- For destructive operations (close, delete), confirm you have the correct repo and issue number
- Return concise, structured summaries of results`;

const githubAgent = createAgent({
  model,
  tools: [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue],
});

export const githubTool = tool(
  async ({ query }) => {
    const response = await githubAgent.invoke({
      messages: [
        { role: 'system', content: GITHUB_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: 'github',
    description:
      'Fetch GitHub data (open PRs, assigned issues, recent pushes) or manage issues (create, close, delete).',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for GitHub operations (e.g., 'List my open PRs', 'Create an issue in second-brain titled Fix login bug', 'What did I push today?')",
        ),
    }),
  },
);
