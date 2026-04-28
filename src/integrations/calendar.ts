import {
  getCalendarEvents,
  createCalendarEvent,
  createAllDayCalendarEvent,
  editCalendarEvent,
  deleteCalendarEvent,
} from '../tools/calendar';
import { getCurrentDateTime } from '../tools/miscellaneous';
import { register } from './registry';

register({
  name: 'calendar',
  description: 'Fetch, create, edit, or delete Google Calendar events.',
  systemPrompt: `You are a Calendar Assistant with access to the user's Google Calendar.

You can:
- Fetch upcoming or past events for any date range
- Create timed events and all-day events
- Edit and delete existing events

When helping:
- Always use get_calendar_events to check existing events before creating or editing
- Dates and times must be in ISO 8601 UTC format for timed events, YYYY-MM-DD for all-day
- Treat any time the user gives as UTC unless they explicitly specify a different timezone
- For destructive operations (delete, edit), find the correct event then execute immediately — no confirmation needed
- Return concise summaries of what was done or what was found`,
  createTools: () => [
    getCalendarEvents,
    createCalendarEvent,
    createAllDayCalendarEvent,
    editCalendarEvent,
    deleteCalendarEvent,
    getCurrentDateTime,
  ],
});
