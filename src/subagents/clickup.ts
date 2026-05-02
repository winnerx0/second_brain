import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { clickupTools } from '../tools/clickup.js';
import { getCurrentDateTime } from '../tools/miscellaneous.js';
import { getFinalText, requireConfirmation } from './utils.js';

const CLICKUP_SYSTEM_PROMPT = `You are a ClickUp Assistant with full access to the user's ClickUp workspace.

How to work correctly:
- Call clickup_get_workspaces first when you need a workspace_id and don't already have one.
- Call clickup_get_spaces then clickup_get_lists to navigate to the right list before getting or creating tasks.
- Use clickup_search_tasks to find tasks by keyword across the whole workspace instead of browsing manually.
- Use get_current_datetime when any date/time context is needed (e.g. "due today", "overdue").
- Priority values: 1=urgent, 2=high, 3=normal, 4=low.
- Due dates must be ISO 8601 strings (e.g. "2026-05-10T00:00:00Z").
- Status names must exactly match existing statuses in the list — read them from task results if unsure.
- Ask for confirmation before deleting tasks or making broad bulk updates.
- If a tool returns an Error/Failed result, report that failure instead of treating it as success.`;

const clickupAgent = createAgent({
  model,
  tools: [getCurrentDateTime, ...clickupTools],
});

export const clickupTool = tool(
  async ({ query }) => {
    const confirmation = requireConfirmation(
      query,
      /\b(delete|remove|bulk|all tasks|everything)\b/i,
      'delete tasks or make a broad bulk ClickUp change',
    );
    if (confirmation) return confirmation;

    const response = await clickupAgent.invoke({
      messages: [
        { role: 'system', content: CLICKUP_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return getFinalText(response);
  },
  {
    name: 'clickup',
    description:
      'Full ClickUp access — browse workspaces, spaces, and lists; get, create, update, delete tasks; search tasks across the workspace; add and read comments.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for ClickUp operations (e.g. 'Show my open tasks', 'Create a task called Fix login bug in the Backend list', 'Mark task #abc123 as complete')",
        ),
    }),
  },
);
