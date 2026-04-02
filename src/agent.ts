import { createAgent, HumanMessage, SystemMessage } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { getOpenPRs, getAssignedIssues, getRecentPushes, createIssue } from "./tools/github.ts";
import { getTodaysEvents } from "./tools/calendar.ts";
import { storeMemory, recallMemories } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns } from "./db/schema.ts";
import { sendTelegramMessage } from "./delivery/telegram.ts";

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

const tools = [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, getTodaysEvents, storeMemory, recallMemories];
const memory = new MemorySaver();

export const agent = createAgent({ model, tools, checkpointer: memory });

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
  "You are a personal productivity assistant. Use your tools to answer the user's question accurately and concisely. Format for Telegram markdown.",
);

const THREAD_ID = "default";

export async function handleMessage(text: string): Promise<string> {
  console.log("[chat] estimated input tokens:", countTokens(CHAT_SYSTEM.content + text));

  const response = await agent.invoke(
    { messages: [CHAT_SYSTEM, new HumanMessage(text)] },
    { recursionLimit: 25, configurable: { thread_id: THREAD_ID } },
  );

  console.log("[chat] actual tokens used:", totalTokensUsed(response.messages as never[]));

  return String(response.messages[response.messages.length - 1]?.content ?? "");
}
