import { tool } from "langchain";
import z from "zod";

export const getCurrentDateTime = tool(async () => new Date().toISOString(), {
  name: "get_current_datetime",
  description:
    "Returns the current date and time in ISO 8601 format. Call this whenever you need to know the current time, date, day of the week, or relative time.",
  schema: z.object({}),
});
