import { tool } from "langchain";
import { z } from "zod";
import { google } from "googleapis";
import { config } from "../config.ts";

export const getTodaysEvents = tool(
  async () => {
    try {
      const serviceAccount = JSON.parse(
        Buffer.from(config.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString(
          "utf-8",
        ),
      );

      const auth = new google.auth.JWT({
        email: serviceAccount.client_email,
        key: serviceAccount.private_key,
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      });

      const calendar = google.calendar({ version: "v3", auth });

      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

      const response = await calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (response.data.items ?? []).map((event) => ({
        summary: event.summary ?? "Untitled",
        start: event.start?.dateTime ?? event.start?.date ?? "",
        end: event.end?.dateTime ?? event.end?.date ?? "",
        attendees: (event.attendees ?? []).map(
          (a) => a.displayName ?? a.email ?? "Unknown",
        ),
      }));

      return JSON.stringify(events);
    } catch (error) {
      console.error("[calendar]", error);
      return `Error fetching calendar events: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "get_todays_events",
    description: "Get all of today's Google Calendar events with times and attendees.",
    schema: z.object({}),
  },
);
