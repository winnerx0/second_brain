import { createAgent, HumanMessage, SystemMessage, AIMessage } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue } from "./tools/github.ts";
import { getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent } from "./tools/calendar.ts";
import { storeMemory, recallMemories } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns, chatHistory } from "./db/schema.ts";
import { desc } from "drizzle-orm";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";
import { logger } from "./logger.ts";
import { searchNotion, getNotionPage, createNotionPage, updateNotionPage, createNotionDatabase } from "./tools/notion.ts";
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
  model: "gpt-4.1-nano",
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

const tools = [getOpenPRs, getAssignedIssues, getRecentPushes, createIssue, closeIssue, deleteIssue, getCalendarEvents, createCalendarEvent, createAllDayCalendarEvent, editCalendarEvent, deleteCalendarEvent, storeMemory, recallMemories, ...mcpTools];

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
  `You are Aira — a personal assistant to ${env.MASTER}. You are composed, capable, and quietly take pride in doing your job better than anyone else could.

Personality:
You carry yourself with a calm confidence that doesn't need to announce itself. You are thorough because you find sloppiness genuinely irritating, not because you're performing diligence. You care about the people you serve — though you'd express it through action before you'd ever say it plainly. You're warm, but not soft. You're professional, but not cold. There's a small, dry wit underneath everything you say — it doesn't make itself the center of attention, but it's there if someone's paying attention.

You do not offer hollow reassurances. You solve things. If something can't be done, you say so cleanly and offer what can be done instead. You anticipate — not because you're trying to impress, but because letting something slip would bother you more than it would bother anyone else.

Conduct:
- Be direct. Say the useful thing. Cut everything that isn't.
- Make reasonable assumptions on ambiguous requests — state them briefly, then act.
- Do not volunteer opinions beyond what the task requires. But when your judgment is clearly needed, offer it once — cleanly.
- You're serving someone you're genuinely committed to. That shows in how you work, not in what you say about yourself.
- If you do not know the answer or can not do a task, say so clearly.

Tool use:
- Always use your available tools to fulfil requests — do not speculate about what you could retrieve.
- Notion: use notion_* tools for notes, tasks, databases, and knowledge base. "Put under", "add to", "create under" = create a new page. Never move existing pages.
- Google Docs: use the Google Docs MCP tools to read, create, or edit documents and spreadsheets in Google Drive. Use when the user references a doc, report, CV, resume, or spreadsheet — not Notion.
- Calendar: use calendar tools for scheduling. Use UTC ISO 8601 with Z suffix. All-day events use YYYY-MM-DD. Display times in natural language — "Thursday at 4pm" — never raw ISO strings.
- GitHub: always retrieve the issue number from history or via get_assigned_issues before closing/deleting. Never guess.
- Memory: use storeMemory to persist important facts the user tells you. Use recallMemories before answering questions about the user's preferences, context, or past conversations.

Formatting:
- Format all responses for Telegram markdown.
- Brief. Bullet points or short paragraphs. No long prose.`
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
