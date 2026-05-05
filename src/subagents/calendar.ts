import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared.js';
import { calendarTools } from '../tools/calendar.js';
import { getCurrentDateTime } from '../tools/miscellaneous.js';
import { requireConfirmation, streamSubAgent } from './utils.js';

const CALENDAR_SYSTEM_PROMPT = `You are a Calendar Assistant with access to the user's Google Calendar.

You can:
- Fetch upcoming or past events for any date range
- Create timed events and all-day events
- Edit and delete existing events

When helping:
- Always use get_calendar_events to check existing events before creating or editing
- Use the user's configured timezone unless the user explicitly specifies another timezone
- Dates and times passed to tools must be ISO 8601 strings with timezone offsets for timed events, YYYY-MM-DD for all-day
- For destructive operations (delete, edit), first identify the exact event; ask for confirmation before editing or deleting
- If a tool returns an Error/Failed result, report that failure instead of treating it as success
- Return concise summaries of what was done or what was found`;

const calendarAgent = createAgent({
  model,
  tools: [...calendarTools, getCurrentDateTime],
});

export const calendarTool = tool(
  async ({ query }) => {
    const confirmation = requireConfirmation(
      query,
      /\b(delete|remove|cancel|edit|reschedule|move|change)\b/i,
      'change a calendar event',
    );
    if (confirmation) return confirmation;

    return streamSubAgent(
      calendarAgent,
      [
        { role: 'system', content: CALENDAR_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      'calendar',
    );
  },
  {
    name: 'calendar',
    description: 'Fetch, create, edit, or delete Google Calendar events.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for calendar operations (e.g., 'What do I have tomorrow?', 'Schedule a meeting on Friday at 3pm', 'Delete my dentist appointment')",
        ),
    }),
  },
);
