import { env } from "bun";
import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
  GOOGLE_CALENDAR_ID: z.string().min(1),
  GOOGLE_CREDENTIALS: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
});

export const config = envSchema.parse(env);
