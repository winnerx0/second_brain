import { tool } from 'langchain';
import { z } from 'zod';
import { google } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const EVENT_MATCH_TOLERANCE_MS = 10 * 60 * 1000;

function loadServiceAccount(): Record<string, string> {
  return JSON.parse(config.GOOGLE_CREDENTIALS);
}

function getCalendarClient() {
  const serviceAccount = loadServiceAccount();

  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

function getLocalDateInUserTimezone(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.USER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  const year = values.year ?? date.getUTCFullYear();
  const month = values.month ?? date.getUTCMonth() + 1;
  const day = values.day ?? date.getUTCDate();
  const hour = values.hour ?? date.getUTCHours();
  const minute = values.minute ?? date.getUTCMinutes();
  const second = values.second ?? date.getUTCSeconds();

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const initialUtc = new Date(
    Date.UTC(year!, month! - 1, day!, hour!, minute!, second ?? 0),
  );
  const offset = getTimeZoneOffsetMs(initialUtc, config.USER_TIMEZONE);
  return new Date(initialUtc.getTime() - offset);
}

function dateRangeToUtcBounds(startDate?: string, endDate?: string) {
  const start = startDate ?? getLocalDateInUserTimezone();
  const end = endDate ?? start;
  return {
    timeMin: zonedDateTimeToUtc(start, '00:00:00'),
    timeMax: zonedDateTimeToUtc(end, '23:59:59'),
  };
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day! + days));
  return utc.toISOString().slice(0, 10);
}

export const getCalendarEvents = tool(
  async ({ startDate, endDate }) => {
    try {
      const calendar = getCalendarClient();

      const { timeMin, timeMax } = dateRangeToUtcBounds(startDate, endDate);

      const response = await calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = (response.data.items ?? []).map((event) => ({
        summary: event.summary ?? 'Untitled',
        start: event.start?.dateTime ?? event.start?.date ?? '',
        end: event.end?.dateTime ?? event.end?.date ?? '',
        attendees: (event.attendees ?? []).map(
          (a) => a.displayName ?? a.email ?? 'Unknown',
        ),
      }));

      return JSON.stringify(events);
    } catch (error) {
      logger.error('[calendar]', error);
      return `Error fetching calendar events: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_calendar_events',
    description: `Get Google Calendar events. Defaults to today in ${config.USER_TIMEZONE} when no dates are provided. Supply startDate and/or endDate (YYYY-MM-DD) to fetch events for any date range.`,
    schema: z.object({
      startDate: z
        .string()
        .optional()
        .describe(
          `Start date in YYYY-MM-DD format (${config.USER_TIMEZONE}). Defaults to today.`,
        ),
      endDate: z
        .string()
        .optional()
        .describe(
          `End date in YYYY-MM-DD format (${config.USER_TIMEZONE}). Defaults to startDate if omitted.`,
        ),
    }),
  },
);

export const createCalendarEvent = tool(
  async ({ summary, start, end, description, attendees }) => {
    try {
      const calendar = getCalendarClient();

      logger.info(
        `[calendar] createCalendarEvent summary=${summary} start=${start} end=${end} description=${description} attendees=${attendees}`,
      );

      const response = await calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: {
          summary,
          ...(description ? { description } : {}),
          start: {
            dateTime: start,
            timeZone: config.USER_TIMEZONE,
          },
          end: { dateTime: end, timeZone: config.USER_TIMEZONE },
          ...(attendees?.length
            ? {
                attendees: attendees.map((email) => ({
                  email,
                })),
              }
            : {}),
        },
      });

      const event = response.data;
      return `Event created: "${event.summary}" on ${event.start?.dateTime ?? event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error('[calendar]', error);
      return `Error creating calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_calendar_event',
    description: `Create a new event on Google Calendar. Start and end must be ISO 8601 datetime strings, preferably with timezone offsets. The default timezone is ${config.USER_TIMEZONE}. Attendees are optional email addresses.`,
    schema: z.object({
      summary: z.string().describe('Event title'),
      start: z
        .string()
        .describe(
          'Start datetime in ISO 8601 format, preferably with timezone offset',
        ),
      end: z
        .string()
        .describe(
          'End datetime in ISO 8601 format, preferably with timezone offset',
        ),
      description: z.string().optional().describe('Event description or notes'),
      attendees: z
        .array(z.string())
        .optional()
        .describe('List of attendee email addresses'),
    }),
  },
);
export const createAllDayCalendarEvent = tool(
  async ({ summary, date, endDate, description, attendees }) => {
    try {
      const calendar = getCalendarClient();

      const response = await calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: {
          summary,
          ...(description ? { description } : {}),
          start: { date },
          end: { date: endDate ?? addDays(date, 1) },
          ...(attendees?.length
            ? {
                attendees: attendees.map((email) => ({
                  email,
                })),
              }
            : {}),
        },
      });

      const event = response.data;
      return `All-day event created: "${event.summary}" on ${event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error('[calendar]', error);
      return `Error creating all-day event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'create_all_day_calendar_event',
    description:
      'Create an all-day Google Calendar event. Use date strings in YYYY-MM-DD format. For multi-day events supply endDate (exclusive — e.g. a 3-day event starting 2026-04-03 ends on 2026-04-06).',
    schema: z.object({
      summary: z.string().describe('Event title'),
      date: z
        .string()
        .describe('Start date in YYYY-MM-DD format (e.g. "2026-04-03")'),
      endDate: z
        .string()
        .optional()
        .describe(
          'End date in YYYY-MM-DD format, exclusive. Defaults to the same day as date.',
        ),
      description: z.string().optional().describe('Event description or notes'),
      attendees: z
        .array(z.string())
        .optional()
        .describe('List of attendee email addresses'),
    }),
  },
);

async function findEventByStart(
  startDateTime: string,
): Promise<{ id: string; summary: string } | null> {
  const calendar = getCalendarClient();
  const target = new Date(startDateTime);
  const dayStart = new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      target.getUTCDate(),
    ),
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: config.GOOGLE_CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const items = response.data.items ?? [];
  if (items.length === 0) return null;

  let closest = items[0]!;
  let closestDiff = Infinity;
  for (const item of items) {
    const eventStart = new Date(item.start?.dateTime ?? item.start?.date ?? '');
    const diff = Math.abs(eventStart.getTime() - target.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = item;
    }
  }

  if (closestDiff > EVENT_MATCH_TOLERANCE_MS) return null;
  if (!closest.id) return null;
  return { id: closest.id, summary: closest.summary ?? 'Untitled' };
}

export const editCalendarEvent = tool(
  async ({
    startDateTime,
    summary,
    newStart,
    newEnd,
    description,
    attendees,
  }) => {
    try {
      const calendar = getCalendarClient();
      const found = await findEventByStart(startDateTime);
      if (!found) return `No event found starting at ${startDateTime}`;

      const response = await calendar.events.update({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId: found.id,
        requestBody: {
          summary,
          ...(description ? { description } : {}),
          start: {
            dateTime: newStart,
            timeZone: config.USER_TIMEZONE,
          },
          end: {
            dateTime: newEnd,
            timeZone: config.USER_TIMEZONE,
          },
          ...(attendees?.length
            ? {
                attendees: attendees.map((email) => ({
                  email,
                })),
              }
            : {}),
        },
      });

      const event = response.data;
      return `Event edited: "${event.summary}" on ${event.start?.dateTime ?? event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error('[calendar]', error);
      return `Error editing calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'edit_calendar_event',
    description:
      'Edit an existing Google Calendar event found by its current start datetime. The current start time must match an event within 10 minutes.',
    schema: z.object({
      startDateTime: z
        .string()
        .describe('Current start datetime of the event to edit as ISO 8601'),
      summary: z.string().describe('New event title'),
      newStart: z.string().describe('New start datetime as ISO 8601'),
      newEnd: z.string().describe('New end datetime as ISO 8601'),
      description: z.string().optional().describe('New event description'),
      attendees: z
        .array(z.string())
        .optional()
        .describe('New list of attendee emails'),
    }),
  },
);

export const deleteCalendarEvent = tool(
  async ({ startDateTime }) => {
    try {
      const calendar = getCalendarClient();
      logger.info(
        `[calendar] deleteCalendarEvent startDateTime=${startDateTime}`,
      );
      const found = await findEventByStart(startDateTime);

      if (!found) return `No event found starting at ${startDateTime}`;

      await calendar.events.delete({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId: found.id,
      });

      return `Event "${found.summary}" deleted successfully`;
    } catch (error) {
      logger.error('[calendar]', error);
      return `Error deleting calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a Google Calendar event found by its start datetime. The start time must match an event within 10 minutes.',
    schema: z.object({
      startDateTime: z
        .string()
        .describe('Start datetime of the event to delete as ISO 8601'),
    }),
  },
);

export const calendarTools = [
  getCalendarEvents,
  createCalendarEvent,
  createAllDayCalendarEvent,
  editCalendarEvent,
  deleteCalendarEvent,
] as const;
