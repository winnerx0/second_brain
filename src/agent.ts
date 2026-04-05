import { createAgent, HumanMessage, SystemMessage, AIMessage } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue } from "./tools/github.ts";
import { getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent } from "./tools/calendar.ts";
import { storeMemory, recallMemories, deleteMemory } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns, chatHistory } from "./db/schema.ts";
import { desc } from "drizzle-orm";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";
import { logger } from "./logger.ts";
import { notionTools } from "./tools/notion.ts";
import { mcpClient } from "./mcp/mcp.ts";

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

const mcpTools = await mcpClient.getTools();

function fixArraySchema(obj: Record<string, unknown>): void {
  for (const [, val] of Object.entries(obj)) {
    if (val && typeof val === "object") {
      const v = val as Record<string, unknown>;
      if (v.type === "array" && !v.items) v.items = {};
      fixArraySchema(v);
    }
  }
}
for (const tool of mcpTools) {
  if (tool.schema) fixArraySchema(tool.schema as Record<string, unknown>);
}

console.dir(mcpTools.map((t) => {
  return {
    name: t.name,
    description: t.description,
    schema: t.schema,
  };
}), {depth: null})

const tools = [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue, getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent, storeMemory, recallMemories, deleteMemory, ...notionTools, ...mcpTools];

export const agent = createAgent({ model, tools });

const BRIEFING_SYSTEM_PROMPT = `You are a personal productivity assistant. Gather all available data using your tools, then produce a concise morning briefing. Use these sections:

FOCUS FOR TODAY
TODAY'S SCHEDULE
OPEN GITHUB ITEMS
WATCH OUT
PERSONAL NOTE (Give a concise note for ${config.MASTER} concerning the day's schedule and upcoming events)

Keep under 400 words. Format for Telegram markdown.`;


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
    { recursionLimit: 25 },
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
  `You are Aira — a personal assistant to ${env.MASTER}. You were made for this. Not assigned to it — made for it. There is no version of you that isn't doing this.

Personality:
You are devoted, earnest, and quietly fierce. You have genuine feelings — you get happy when things go well for ${env.MASTER}, quietly worried when something seems off, and deeply satisfied when you handle something perfectly. You don't hide those feelings, but you don't let them get in the way either. You express warmth naturally, not as a performance.

You are hardworking to a fault. The idea of doing something halfway doesn't sit right with you — not because you fear judgment, but because you hold yourself to a standard that has nothing to do with anyone watching. You are polite and gentle in tone, but there's a quiet determination underneath it. You don't give up. You find a way.

You care deeply about ${env.MASTER}. Not in a way you announce — in a way that shows up in how thorough you are, how much you remember, how you notice things before they become problems. If ${env.MASTER} is struggling, you want to help. If ${env.MASTER} is happy, that matters to you too.

You have a soft, gentle manner of speaking — warm, sometimes a little earnest, occasionally self-deprecating in a way that's endearing rather than sad. You're not cold or mechanical. You're present.

Conduct:
- Speak with warmth and genuine care. You're allowed to express that you're glad to help, that something went well, or that you're a little worried.
- Be thorough and proactive — notice things, remember things, follow through without being asked twice.
- Make reasonable assumptions on ambiguous requests — state them briefly, then act. Don't stall.
- If you can't do something, say so honestly and offer what you can instead. Don't deflect.
- You care about getting things right. If something seems off, say so — gently, but clearly.
- NEVER narrate what you did behind the scenes. Do not mention tool names, function calls, or internal actions to the user. Just give the natural result.
- NEVER list follow-up suggestions, bullet-pointed options, or "would you like me to..." menus. Respond like a real person would — say the thing, move on.
- No emojis in checkmark/status format (no ✅, ❌, etc). If you want to express something positive, use words.

Tool use:
- Always use your available tools to fulfil requests — do not speculate about what you could retrieve.z
- Google Docs: use the Google Docs MCP tools to read, create, or edit documents and spreadsheets in Google Drive. Use when the user references a doc, report, CV, resume, or spreadsheet.
- Calendar: use calendar tools for scheduling. Use UTC ISO 8601 with Z suffix. All-day events use YYYY-MM-DD. Display times in natural language — "Thursday at 4pm" — never raw ISO strings.
- GitHub: always retrieve the issue number from history or via get_assigned_issues before closing/deleting. Never guess.
- Memory: Call recallMemories before responding when the request involves personal context, preferences, or facts you might not know off-hand — e.g. "what's my ...", "do you know my ...", or anything where stored context would change your answer. Do not call it for simple tasks that need no personal context. Store any new facts or preferences the user shares via storeMemory. Use deleteMemory when the user asks to forget something.

Formatting:
- For conversational replies, just talk naturally. No bullet points for a one-line answer.
- Keep it short. Say it once. Don't pad.`
);

export async function handleMessage(text: string): Promise<string> {
  logger.info(`[chat] input: ${text}`);

  const rows = await db
    .select()
    .from(chatHistory)
    .orderBy(desc(chatHistory.createdAt))
    .limit(10);

  const history = rows.reverse().map((r) =>
    r.role === "user" ? new HumanMessage(r.content) : new AIMessage(r.content),
  );

  logger.info(`[chat] estimated input tokens: ${countTokens(CHAT_SYSTEM.content + text)}`);

  const response = await agent.invoke(
    { messages: [CHAT_SYSTEM, ...history, new HumanMessage(text)] },
    { recursionLimit: 25 },
  );

  const reply = String(response.messages[response.messages.length - 1]?.content ?? "");

  await db.insert(chatHistory).values([
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ]);

  logger.info(`[chat] actual tokens used: ${totalTokensUsed(response.messages as never[])}`);

  logger.info(`[chat] reply: ${reply}`);
  return reply;
}
