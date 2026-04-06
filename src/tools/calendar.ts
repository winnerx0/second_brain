import { tool } from "langchain";
import { z } from "zod";
import { google } from "googleapis";
import { config } from "../config.ts";
import { logger } from "../logger.ts";

function loadServiceAccount(): Record<string, string> {
  return JSON.parse(config.GOOGLE_CREDENTIALS);
}

function getCalendarClient() {
  const serviceAccount = loadServiceAccount();

  const auth = new google.auth.JWT({
    email: serviceAccount.client_email,
    key: serviceAccount.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

export const getCalendarEvents = tool(
  async ({ startDate, endDate }) => {
    try {
      const calendar = getCalendarClient();

      const now = new Date();
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

      const timeMin = startDate
        ? new Date(startDate + "T00:00:00Z")
        : todayUTC;
      const timeMax = endDate
        ? new Date(endDate + "T23:59:59Z")
        : new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);

      const response = await calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (response.data.items ?? []).map((event) => ({
        id: event.id ?? "",
        summary: event.summary ?? "Untitled",
        start: event.start?.dateTime ?? event.start?.date ?? "",
        end: event.end?.dateTime ?? event.end?.date ?? "",
        attendees: (event.attendees ?? []).map(
          (a) => a.displayName ?? a.email ?? "Unknown",
        ),
      }));

      return JSON.stringify(events);
    } catch (error) {
      logger.error("[calendar]", error);
      return `Error fetching calendar events: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "get_calendar_events",
    description:
      "Get Google Calendar events. Defaults to today (UTC) when no dates are provided. Supply startDate and/or endDate (YYYY-MM-DD) to fetch events for any date range.",
    schema: z.object({
      startDate: z.string().optional().describe("Start date in YYYY-MM-DD format (UTC). Defaults to today."),
      endDate: z.string().optional().describe("End date in YYYY-MM-DD format (UTC). Defaults to startDate if omitted."),
    }),
  },
);

export const createCalendarEvent = tool(
  async ({ summary, start, end, description, attendees }) => {
    try {
      const calendar = getCalendarClient();

      const response = await calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: {
          summary,
          ...(description ? { description } : {}),
          start: { dateTime: start, timeZone: "UTC" },
          end: { dateTime: end, timeZone: "UTC" },
          ...(attendees?.length
            ? { attendees: attendees.map((email) => ({ email })) }
            : {}),
        },
      });

      const event = response.data;
      return `Event created: "${event.summary}" on ${event.start?.dateTime ?? event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error("[calendar]", error);
      return `Error creating calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "create_calendar_event",
    description:
      "Create a new event on Google Calendar. Start and end must be ISO 8601 datetime strings (e.g. \"2026-04-03T14:00:00Z\"). Attendees are optional email addresses.",
    schema: z.object({
      summary: z.string().describe("Event title"),
      start: z.string().describe("Start datetime in ISO 8601 UTC format (e.g. \"2026-04-03T14:00:00Z\")"),
      end: z.string().describe("End datetime in ISO 8601 UTC format (e.g. \"2026-04-03T15:00:00Z\")"),
      description: z.string().optional().describe("Event description or notes"),
      attendees: z.array(z.string()).optional().describe("List of attendee email addresses"),
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
          end: { date: endDate ?? date },
          ...(attendees?.length
            ? { attendees: attendees.map((email) => ({ email })) }
            : {}),
        },
      });

      const event = response.data;
      return `All-day event created: "${event.summary}" on ${event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error("[calendar]", error);
      return `Error creating all-day event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "create_all_day_calendar_event",
    description:
      "Create an all-day Google Calendar event. Use date strings in YYYY-MM-DD format. For multi-day events supply endDate (exclusive — e.g. a 3-day event starting 2026-04-03 ends on 2026-04-06).",
    schema: z.object({
      summary: z.string().describe("Event title"),
      date: z.string().describe("Start date in YYYY-MM-DD format (e.g. \"2026-04-03\")"),
      endDate: z.string().optional().describe("End date in YYYY-MM-DD format, exclusive. Defaults to the same day as date."),
      description: z.string().optional().describe("Event description or notes"),
      attendees: z.array(z.string()).optional().describe("List of attendee email addresses"),
    }),
  },
);

async function findEventByStart(startDateTime: string): Promise<{ id: string; summary: string } | null> {
  const calendar = getCalendarClient();
  const target = new Date(startDateTime);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: config.GOOGLE_CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = response.data.items ?? [];
  if (items.length === 0) return null;

  let closest = items[0]!;
  let closestDiff = Infinity;
  for (const item of items) {
    const eventStart = new Date(item.start?.dateTime ?? item.start?.date ?? "");
    const diff = Math.abs(eventStart.getTime() - target.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = item;
    }
  }

  if (!closest.id) return null;
  return { id: closest.id, summary: closest.summary ?? "Untitled" };
}

export const editCalendarEvent = tool(
  async ({ startDateTime, summary, newStart, newEnd, description, attendees }) => {
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
          start: { dateTime: newStart, timeZone: "UTC" },
          end: { dateTime: newEnd, timeZone: "UTC" },
          ...(attendees?.length
            ? { attendees: attendees.map((email) => ({ email })) }
            : {}),
        },
      });

      const event = response.data;
      return `Event edited: "${event.summary}" on ${event.start?.dateTime ?? event.start?.date} — ${event.htmlLink}`;
    } catch (error) {
      logger.error("[calendar]", error);
      return `Error editing calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "edit_calendar_event",
    description:
      "Edit an existing Google Calendar event found by its current start datetime.",
    schema: z.object({
      startDateTime: z.string().describe("Current start datetime of the event to edit (ISO 8601 UTC, e.g. \"2026-04-03T14:00:00Z\")"),
      summary: z.string().describe("New event title"),
      newStart: z.string().describe("New start datetime (ISO 8601 UTC, e.g. \"2026-04-03T14:00:00Z\")"),
      newEnd: z.string().describe("New end datetime (ISO 8601 UTC, e.g. \"2026-04-03T15:00:00Z\")"),
      description: z.string().optional().describe("New event description"),
      attendees: z.array(z.string()).optional().describe("New list of attendee emails"),
    }),
  },
);

export const deleteCalendarEvent = tool(
  async ({ eventId, startDateTime }) => {
    try {
      const calendar = getCalendarClient();

      let id = eventId;
      let summary = "Event";

      if (!id) {
        if (!startDateTime) return "Provide either eventId or startDateTime";
        const found = await findEventByStart(startDateTime);
        if (!found) return `No event found starting at ${startDateTime}`;
        id = found.id;
        summary = found.summary;
      }

      await calendar.events.delete({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId: id,
      });

      return `Event "${summary}" deleted successfully`;
    } catch (error) {
      logger.error("[calendar]", error);
      return `Error deleting calendar event: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "delete_calendar_event",
    description:
      "Delete a Google Calendar event. Prefer using eventId (from get_calendar_events). Falls back to finding by startDateTime if eventId is not available.",
    schema: z.object({
      eventId: z.string().optional().describe("Event ID from get_calendar_events — use this when available"),
      startDateTime: z.string().optional().describe("Start datetime of the event (ISO 8601 UTC). Used only if eventId is not provided."),
    }),
  },
);

