import {
  getOpenPRs,
  getAssignedIssues,
  getRecentPushes,
  createIssue,
  closeIssue,
  deleteIssue,
} from '../tools/github';
import { register } from './registry';

register({
  name: 'github',
  description:
    'Fetch GitHub data (open PRs, assigned issues, recent pushes) or manage issues (create, close, delete).',
  requiredEnv: ['GITHUB_TOKEN'],
  systemPrompt: `You are a GitHub Assistant with access to the user's GitHub account.

You can:
- Fetch open pull requests, assigned issues, and recent pushes
- Create, close, and delete issues

When helping:
- Always use real data from tools, never guess or fabricate
- For destructive operations (close, delete), confirm you have the correct repo and issue number
- Return concise, structured summaries of results`,
  createTools: () => [
    getOpenPRs,
    getAssignedIssues,
    getRecentPushes,
    createIssue,
    closeIssue,
    deleteIssue,
  ],
});
