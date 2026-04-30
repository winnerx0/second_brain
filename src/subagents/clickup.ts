import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared';
import { clickupTools } from '../tools/clickup';
import { getCurrentDateTime } from '../tools/miscellaneous';

const CLICKUP_SYSTEM_PROMPT = `You are a ClickUp Assistant with full access to the user's ClickUp workspace.

How to work correctly:
- Call clickup_get_workspaces first when you need a workspace_id and don't already have one.
- Call clickup_get_spaces then clickup_get_lists to navigate to the right list before getting or creating tasks.
- Use clickup_search_tasks to find tasks by keyword across the whole workspace instead of browsing manually.
- Use get_current_datetime when any date/time context is needed (e.g. "due today", "overdue").
- Priority values: 1=urgent, 2=high, 3=normal, 4=low.
- Due dates must be ISO 8601 strings (e.g. "2026-05-10T00:00:00Z").
- Status names must exactly match existing statuses in the list — read them from task results if unsure.`;

const clickupAgent = createAgent({
  model,
  tools: [getCurrentDateTime, ...clickupTools],
});

export const clickupTool = tool(
  async ({ query }) => {
    const response = await clickupAgent.invoke({
      messages: [
        { role: 'system', content: CLICKUP_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
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
