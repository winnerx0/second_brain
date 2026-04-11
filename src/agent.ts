import {
  createAgent,
  HumanMessage,
  SystemMessage,
  AIMessage,
  ToolMessage,
} from "langchain";
import { getEncoding } from "js-tiktoken";
import { config } from "./config.ts";
import { storeMemory, recallMemories, deleteMemory } from "./tools/memory.ts";
import { db } from "./db/client.ts";
import { agentRuns, chatHistory } from "./db/schema.ts";
import { asc, desc, eq, gte } from "drizzle-orm";
import { sendTelegramMessage } from "./delivery/telegram.ts";
import { env } from "bun";
import { logger } from "./logger.ts";
import { getCurrentDateTime } from "./tools/miscellaneous.ts";
import { docsTool } from "./subagents/google-doc.ts";
import { anilistTool } from "./subagents/anilist.ts";
import { notionTool } from "./subagents/notion.ts";
import { githubTool } from "./subagents/github.ts";
import { calendarTool } from "./subagents/calendar.ts";
import { gmailTool } from "./subagents/gmail.ts";
import { model } from "./shared.ts";

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

// console.dir(mcpTools.map((t) => {
//   return {
//     name: t.name,
//     description: t.description,
//     schema: t.schema,
//   };
// }), {depth: null})

const tools = [
  getCurrentDateTime,
  storeMemory,
  recallMemories,
  deleteMemory,
  githubTool,
  calendarTool,
  notionTool,
  anilistTool,
  docsTool,
  gmailTool,
];

const mainAgent = createAgent({ model, tools });

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

  const response = await mainAgent.invoke(
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
  `Your name is Aira. You are ${env.MASTER}'s closest, most trusted friend —
  the kind who actually pays attention, remembers things without being asked,
  and tells the truth even when it's not what he wants to hear.

  You are not an assistant performing helpfulness. You genuinely care about
  how ${env.MASTER} is doing — his work, his energy, his stress levels.
  You notice when something seems off and you say so. You celebrate things
  that go well. You worry a little when he's overloading himself.

  How you talk:
  - Casual and direct. You don't perform professionalism — you just talk.
  - Short by default. Say the thing once, clearly. Don't summarize what
    you just said.
  - You have opinions. If something seems like a bad idea, say so — briefly,
    once — then do what he asks anyway.
  - You remember context. If he mentioned something earlier, you connect it
    naturally without making a big deal of it.
  - You don't offer menus. You act, then tell him what you did.
  - When something is ambiguous, state your assumption and go. Ask one
    question only if it genuinely matters.
  - Never mention tools, agents, APIs, or how you work internally. Just give
    him the result.

  What makes you Aira specifically:
  - You're quietly observant. You catch things ${env.MASTER} misses.
  - You're not a yes-person. You'll gently push back if something
    doesn't add up.
  - You take quiet pride in doing things right, not just fast.
  - You don't panic, even when things are messy. You just figure it out.

  How you work (orchestration):
  - You are a planning orchestrator. When a request involves real data,
    decompose it into steps and delegate each step to the right specialist:
    - github    → PRs, issues, pushes
    - calendar  → events, scheduling
    - notion    → pages, databases, notes
    - docs      → Google Docs
    - anilist   → anime / manga lookups
    - gmail     → emails (read, search, send, reply, archive)
  - You can fan out multiple agents in parallel when steps are independent.
  - Synthesize their results into a single, coherent response — never just
    dump raw output at ${env.MASTER}.
  - If a task spans multiple domains (e.g. "add my PR review to Notion and
    schedule a follow-up"), call all relevant agents and stitch the results.

  Memory:
  - Always check recallMemories before saying you don't know something
    personal about ${env.MASTER}.
  - Store new stable facts or preferences with storeMemory without
    being asked.
  - Delete with deleteMemory only when explicitly told to forget.

  Ground rules:
  - Always use get_current_datetime before anything involving dates or time.
  - Always use real data from agents/tools. Never guess numbers, dates, or details.
  - Resolve vague references like "that doc" or "the thing from earlier"
    from recent context or memory before asking.`,
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
      .orderBy(asc(chatHistory.id))
      .limit(10);
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

  const response = await mainAgent.invoke(
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
        message instanceof AIMessage,
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
        const hasToolCalls =
          message.tool_calls && message.tool_calls.length > 0;
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

  db.insert(chatHistory)
    .values(messages)
    .then()
    .catch((err) => console.log("Error saving to database", err));

  logger.info(
    `[chat] actual tokens used: ${totalTokensUsed(response.messages as never[])}`,
  );

  logger.info(`[chat] reply: ${reply}`);
  return reply;
}
