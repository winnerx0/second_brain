import { z } from 'zod';

const env = process.env;

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
  GOOGLE_CALENDAR_ID: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  NOTION_TOKEN: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_API_KEY: z.string().min(1),
  KIVIA_API_KEY: z.string().min(1),
  ANILIST_TOKEN: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z
    .string()
    .min(1)
    .default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  USER_TIMEZONE: z.string().min(1).default('UTC'),
  // Gmail
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  OAUTH_REDIRECT_BASE_URL: z.string().min(1).default('http://localhost:80'),
  APP_URL: z.string().min(1).default('http://localhost:3001'),
  XAI_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().min(1),
  // Voice (Deepgram Voice Agent API)
  DEEPGRAM_API_KEY: z.string().optional(),
  // Shared secret the voice LLM adapter requires from Deepgram's think endpoint calls
  VOICE_LLM_SECRET: z.string().optional(),
  // Public base URL Deepgram's servers use to reach the think endpoint.
  // In dev this is a tunnel (cloudflared/ngrok) to the local backend.
  PUBLIC_API_URL: z.string().optional(),
});

export const config = envSchema.parse(env);
