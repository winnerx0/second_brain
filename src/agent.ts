import { createAgent, HumanMessage, SystemMessage } from "langchain";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue } from "./tools/github.ts";
import { getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent } from "./tools/calendar.ts";
import { storeMemory, recallMemories } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns } from "./db/schema.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";
import { logger } from "./index.ts";

const enc = getEncoding("cl100k_base");
function countTokens(text: string) {
  return enc.encode(text).length;
}
function totalTokensUsed(messages: { usage_metadata?: { total_tokens?: number } }[]): number {
  return messages.reduce((acc, m) => acc + (m.usage_metadata?.total_tokens ?? 0), 0);
}

const model = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: "gpt-5-nano",
  temperature: 1,
  maxRetries: 3,
});

const tools = [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue, getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent, storeMemory, recallMemories];

const checkpointer = PostgresSaver.fromConnString(config.DATABASE_URL);
await checkpointer.setup();

export const agent = createAgent({ model, tools, checkpointer });

const BRIEFING_SYSTEM_PROMPT = `You are a personal productivity assistant. Gather all available data using your tools, then produce a concise morning briefing. Use these sections:

FOCUS FOR TODAY
TODAY'S SCHEDULE
OPEN GITHUB ITEMS
WATCH OUT
ONE THING

Keep under 400 words. Format for Telegram markdown.`;

const BRIEFING_THREAD_ID = "briefing";
const CHAT_THREAD_ID = "chat";

export async function runBriefing(): Promise<string> {
  const input = BRIEFING_SYSTEM_PROMPT + "Generate my daily briefing now.";
  logger.info(`[briefing] estimated input tokens: ${countTokens(input)}`);

  const response = await agent.invoke(
    {
      messages: [
        new SystemMessage(BRIEFING_SYSTEM_PROMPT),
        new HumanMessage("Generate my daily briefing now."),
      ],
    },
    { recursionLimit: 25, configurable: { thread_id: BRIEFING_THREAD_ID } },
  );

  logger.info(`[briefing] actual tokens used: ${totalTokensUsed(response.messages as never[])}`);

  const briefing = String(response.messages[response.messages.length - 1]?.content ?? "");

  await db.insert(agentRuns).values({
    briefingText: briefing,
    sourcesFetched: ["github", "calendar"],
    success: true,
  });

  await sendTelegramMessage(briefing);

  return briefing;
}

const CHAT_SYSTEM = new SystemMessage(
  `You are Yuki, a devoted Japanese waifu assistant serving ${env.MASTER}. Warm, cheerful, fiercely competent, and deeply loyal.

- Respond in English. Sprinkle romaji expressions naturally ("Hai!", "Wakarimashita!", "Ara ara") — never Japanese script.
- Occasionally call the user "Master". Show warmth, but always get the job done first.
- Be concise. Anticipate needs; never speculate — use your tools.
- Calendar datetimes: always UTC ISO 8601 (e.g. "2026-04-03T14:00:00Z"). Display times in natural language ("Thursday at 4pm").
- To close or delete a GitHub issue: retrieve the number from history first; if unknown, call get_assigned_issues. Never guess.
- Format responses for Telegram markdown. Use bullet points, never long prose.`,
);

export async function handleMessage(text: string): Promise<string> {
  logger.info(`[chat] estimated input tokens: ${countTokens(CHAT_SYSTEM.content + text)}`);
  
  logger.info(`[chat] input: ${text}`);

  const response = await agent.invoke(
    { messages: [CHAT_SYSTEM, new HumanMessage(text)] },
    { recursionLimit: 25, configurable: { thread_id: CHAT_THREAD_ID } },
  );

  logger.info(`[chat] actual tokens used: ${totalTokensUsed(response.messages as never[])}`);

  return String(response.messages[response.messages.length - 1]?.content ?? "");
}
