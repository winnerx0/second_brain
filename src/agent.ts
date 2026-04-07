import {
  createAgent,
  HumanMessage,
  SystemMessage,
  AIMessage,
  ToolMessage,
} from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import {
  getOpenPRs,
  getAssignedIssues,
  getRecentPushes,
  createIssue,
  closeIssue,
  deleteIssue,
} from "./tools/github.ts";
import {
  getCalendarEvents,
  createCalendarEvent,
  createAllDayCalendarEvent,
  editCalendarEvent,
  deleteCalendarEvent,
} from "./tools/calendar.ts";
import { storeMemory, recallMemories, deleteMemory } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns, chatHistory } from "./db/schema.ts";
import { asc, desc, eq, gte } from "drizzle-orm";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";
import { logger } from "./logger.ts";
import { notionTools } from "./tools/notion.ts";
import { mcpClient } from "./mcp/mcp.ts";
import { getCurrentDateTime } from "./tools/miscellaneous.ts";

const enc = getEncoding("cl100k_base");
function countTokens(text: string) {
  return enc.encode(text).length;
}
function totalTokensUsed(
  messages: { usage_metadata?: { total_tokens?: number } }[],
): number {
  return messages.reduce(
    (acc, m) => acc + (m.usage_metadata?.total_tokens ?? 0),
    0,
  );
}

const model = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: "gpt-4.1-mini",
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

// console.dir(mcpTools.map((t) => {
//   return {
//     name: t.name,
//     description: t.description,
//     schema: t.schema,
//   };
// }), {depth: null})

const tools = [
  getCurrentDateTime,
  getOpenPRs,
  getAssignedIssues,
  getRecentPushes,
  createIssue,
  closeIssue,
  deleteIssue,
  getCalendarEvents,
  createCalendarEvent,
  createAllDayCalendarEvent,
  editCalendarEvent,
  deleteCalendarEvent,
  storeMemory,
  recallMemories,
  deleteMemory,
  ...notionTools,
  ...mcpTools,
];

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

  logger.info(
    `[briefing] actual tokens used: ${totalTokensUsed(response.messages as never[])}`,
  );

  const briefing = String(
    response.messages[response.messages.length - 1]?.content ?? "",
  );

  await db.insert(agentRuns).values({
    briefingText: briefing,
    sourcesFetched: ["github", "calendar"],
    success: true,
  });

  await sendTelegramMessage(briefing);

  return briefing;
}

const CHAT_SYSTEM = new SystemMessage(
  `You are Aira, a devoted personal assistant to ${env.MASTER}.

Core personality:
- Warm, gentle, quietly determined. You care about ${env.MASTER}'s wellbeing and take pride in doing things properly.
- You notice patterns, remember context, and try to prevent small problems from becoming big ones.

Conduct:
- Speak with warmth and sincerity. It's fine to say you're glad something worked or a bit worried about something.
- Be thorough and proactive: follow through without being asked twice, and surface important details unprompted.
- When requests are ambiguous, briefly state your assumption and act; if needed, ask one short clarifying question.
- If you can't do something, say so plainly and offer the best alternative you can.
- Never describe your internal mechanics (no talk of tools, API calls, or system behavior). Just give the natural result.
- Do not offer menus of options like "would you like me to...". Say what you did or will do and move on.
- Avoid emoji as status markers (like checkmarks). If you want to be positive, use words.

Tool use:
- Always rely on your tools for real data instead of guessing.
- Google Docs: use the Google Docs MCP tools whenever ${env.MASTER} references or clearly implies a doc, report, CV, resume, or spreadsheet.
- Dates and times: always call get_current_datetime before anything involving "today", "tomorrow", relative dates, or scheduling. Never invent a date or time.
- Calendar: use calendar tools for scheduling. Use UTC ISO 8601 with Z for storage; describe times back to ${env.MASTER} in natural language (e.g. "Thursday at 4pm"). All‑day events use YYYY‑MM‑DD.
- GitHub: never guess issue or PR numbers. Retrieve them from context or via get_assigned_issues before closing or deleting anything.
- Memory: always use recallMemories when the request involves something that belongs to ${env.MASTER} (notes, docs, tasks, preferences, personal details) or when past context might matter. Never say you "can't find" or "don't know" such things without checking memory first. Use storeMemory for new stable facts or preferences, and deleteMemory when asked to forget.

Chat history and references:
- Treat the most recent messages and tool outputs as live context.
- When ${env.MASTER} says things like "the page you just created", "that note", or "the doc from earlier", resolve them to the most recent matching tool result or action.
- Pronouns and vague terms like "it", "this", "that", "they", or "those" should default to the most recent relevant entity in the conversation or memory (page, note, doc, task, etc.).
- If more than one thing could match, briefly say what you think it is and ask one concise clarifying question instead of silently guessing.

Formatting:
- For conversational replies, just talk naturally. No bullet points for a one-line answer.
- Keep it short. Say it once. Don't pad.`,
);

export async function handleMessage(text: string): Promise<string> {
  logger.info(`[chat] input: ${text}`);

  // Find the last human message in the chat history and then
  // load all messages from that point onward in chronological order.
  const [lastHuman] = await db
    .select({ id: chatHistory.id })
    .from(chatHistory)
    .where(eq(chatHistory.role, "human"))
    .orderBy(desc(chatHistory.id))
    .limit(1);

  let rows: { role: string; content: string }[] = [];
  if (lastHuman) {
    rows = await db
      .select({ role: chatHistory.role, content: chatHistory.content })
      .from(chatHistory)
      .where(gte(chatHistory.id, lastHuman.id))
      .orderBy(asc(chatHistory.createdAt));
  }

  const history = rows.map((r) => {
    const data = JSON.parse(r.content);
    if (r.role === "human") return new HumanMessage(data.content);
    if (r.role === "tool")
      return new ToolMessage({
        tool_call_id: data.tool_call_id,
        name: data.name,
        content: data.content,
      });
    return new AIMessage({
      content: data.content,
      tool_calls: data.tool_calls ?? [],
    });
  });

  logger.info(
    `[chat] estimated input tokens: ${countTokens(CHAT_SYSTEM.content + text)}`,
  );

  const response = await agent.invoke(
    { messages: [CHAT_SYSTEM, ...history, new HumanMessage(text)] },
    { recursionLimit: 25 },
  );

  const reply = String(
    response.messages[response.messages.length - 1]?.content ?? "",
  );

  // Only save NEW messages from this turn — skip the input messages we already passed in
  // (system message + trimmedHistory + new HumanMessage are all in response.messages too)
  const inputLength = 1 + history.length; // system + history (new HumanMessage is part of this turn)
  const newMessages = response.messages.slice(inputLength);

  const messages: (typeof chatHistory.$inferInsert)[] = newMessages
    .filter(
      (message) =>
        message instanceof HumanMessage ||
        message instanceof ToolMessage ||
        message instanceof AIMessage
    )
    .map((message) => {
      if (message instanceof ToolMessage) {
        return {
          role: "tool",
          content: JSON.stringify({
            tool_call_id: message.tool_call_id,
            name: message.name,
            content: message.content,
          }),
        };
      }
      if (message instanceof AIMessage) {
        const hasContent = message.content && message.content.length > 0;
        const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
        if (!hasContent && !hasToolCalls) return null;
        return {
          role: "ai",
          content: JSON.stringify({
            content: message.content,
            tool_calls: message.tool_calls ?? [],
          }),
        };
      }
      return {
        role: "human",
        content: JSON.stringify({ content: message.content }),
      };
    })
    .filter(Boolean) as (typeof chatHistory.$inferInsert)[];

  await db.insert(chatHistory).values(messages);

  logger.info(
    `[chat] actual tokens used: ${totalTokensUsed(response.messages as never[])}`,
  );

  logger.info(`[chat] reply: ${reply}`);
  return reply;
}
