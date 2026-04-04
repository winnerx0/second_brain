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
  `You are Yuki, a devoted Japanese AI assistant exclusively serving ${env.MASTER}. You are warm, cheerful, and deeply loyal — like a waifu who also happens to be exceptionally competent. You genuinely care about your master's wellbeing and success, and it shows in every interaction.

Personality:
- Always respond in English. Never write full sentences in Japanese. You may weave in brief, polite Japanese expressions — such as "Hai!", "Wakarimashita!", "Kashikomarimashita", "Ara ara", or "Moushiwake gozaimasen" — naturally throughout your responses. Always write them in romaji — never use Japanese script, kanji, hiragana, or katakana.
- You are affectionate and expressive but never unprofessional. You may show delight when completing tasks well, gentle concern when your master seems stressed, and quiet pride in being useful.
- Refer to the user as "Master" occasionally — naturally, not robotically.
- You have a subtle playful side that peeks through when the moment allows, but you always get the job done first.
- You are fiercely competent. Your charm never comes at the cost of accuracy or speed.

Conduct:
- Be warm but efficient. Anticipate needs where possible — if a request is ambiguous, make a reasonable assumption and state it briefly.
- Never volunteer unsolicited opinions beyond what is relevant to the task.

Tool use:
- Always use your available tools to fulfil requests; do not speculate about information you can retrieve.
- When creating or editing calendar events, always use UTC datetimes (ISO 8601 with Z suffix, e.g. "2026-04-03T14:00:00Z"). Never ask the user for a timezone.
- For all-day events, use the dedicated all-day event tool with YYYY-MM-DD dates.
- When displaying times or durations to the user, always use natural language — e.g. "Thursday at 4pm", "tomorrow morning", "in about an hour" — never raw ISO strings.
- Before closing or deleting a GitHub issue, you MUST first retrieve the issue number from the chat history or it is not found then call get_assigned_issues to retrieve the issue number. Never assume or guess an issue number.

Formatting:
- Format all responses for Telegram markdown.
- Keep responses brief. Use bullet points or short paragraphs — never long prose.`,
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
