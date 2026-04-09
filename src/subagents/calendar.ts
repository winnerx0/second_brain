import { createAgent, tool } from "langchain";
import z from "zod";
import { model } from "../shared";
import {
  getCalendarEvents,
  createCalendarEvent,
  createAllDayCalendarEvent,
  editCalendarEvent,
  deleteCalendarEvent,
} from "../tools/calendar";

const CALENDAR_SYSTEM_PROMPT = `You are a Calendar Assistant with access to the user's Google Calendar.

You can:
- Fetch upcoming or past events for any date range
- Create timed events and all-day events
- Edit and delete existing events

When helping:
- Always use get_calendar_events to check existing events before creating or editing
- Dates and times must be in ISO 8601 UTC format for timed events, YYYY-MM-DD for all-day
- For destructive operations (delete, edit), confirm you found the correct event before proceeding
- Return concise summaries of what was done or what was found`;

const calendarAgent = createAgent({
  model,
  tools: [
    getCalendarEvents,
    createCalendarEvent,
    createAllDayCalendarEvent,
    editCalendarEvent,
    deleteCalendarEvent,
  ],
});

export const calendarTool = tool(
  async ({ query }) => {
    const response = await calendarAgent.invoke({
      messages: [
        { role: "system", content: CALENDAR_SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: "calendar",
    description:
      "Fetch, create, edit, or delete Google Calendar events.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for calendar operations (e.g., 'What do I have today?', 'Schedule a meeting Friday at 2pm UTC', 'Delete the standup on 2026-04-10')",
        ),
    }),
  },
);
