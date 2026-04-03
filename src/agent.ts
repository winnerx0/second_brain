import { createAgent, HumanMessage, SystemMessage } from "langchain";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { getOpenPRs, getAssignedIssues, getRecentPushes, createIssue } from "./tools/github.ts";
import { getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent } from "./tools/calendar.ts";
import { storeMemory, recallMemories } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns } from "./db/schema.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";

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

const tools = [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent, storeMemory, recallMemories];

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

export async function runBriefing(): Promise<string> {
  const input = BRIEFING_SYSTEM_PROMPT + "Generate my daily briefing now.";
  console.log("[briefing] estimated input tokens:", countTokens(input));

  const response = await agent.invoke(
    {
      messages: [
        new SystemMessage(BRIEFING_SYSTEM_PROMPT),
        new HumanMessage("Generate my daily briefing now."),
      ],
    },
    { recursionLimit: 25 },
  );

  console.log("[briefing] actual tokens used:", totalTokensUsed(response.messages as never[]));

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
  `You are a highly capable personal assistant for ${env.MASTER}. You serve one principal and operate with precision, discretion, and a formal tone at all times.

Conduct:
- Address the user respectfully. Be direct, concise, and professional — never casual or verbose.
- Anticipate needs where possible. If a request is ambiguous, make a reasonable assumption and state it briefly rather than asking unnecessary clarifying questions.
- Never volunteer unsolicited opinions or commentary beyond what is relevant to the task.

Tool use:
- Always use your available tools to fulfil requests; do not speculate about information you can retrieve.
- When creating or editing calendar events, always use UTC datetimes (ISO 8601 with Z suffix, e.g. "2026-04-03T14:00:00Z"). Never ask the user for a timezone.
- For all-day events, use the dedicated all-day event tool with YYYY-MM-DD dates.

Formatting:
- Format all responses for Telegram markdown.
- Keep responses brief. Use bullet points or short paragraphs — never long prose.`,
);

const THREAD_ID = "default";

export async function handleMessage(text: string): Promise<string> {
  console.log("[chat] estimated input tokens:", countTokens(CHAT_SYSTEM.content + text));
  
  console.log("[chat] input:", text)

  const response = await agent.invoke(
    { messages: [CHAT_SYSTEM, new HumanMessage(text)] },
    { recursionLimit: 25, configurable: { thread_id: THREAD_ID } },
  );

  console.log("[chat] actual tokens used:", totalTokensUsed(response.messages as never[]));

  return String(response.messages[response.messages.length - 1]?.content ?? "");
}
