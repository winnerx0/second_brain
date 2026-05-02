import {
  createAgent,
  HumanMessage,
  SystemMessage,
  AIMessage,
  ToolMessage,
  summarizationMiddleware,
} from 'langchain';
import type { AIMessageChunk } from '@langchain/core/messages';
import { getEncoding } from 'js-tiktoken';
import { config } from './config.ts';
import { storeMemory, recallMemories, deleteMemory } from './tools/memory';
import { db } from './db/client.ts';
import { agentRuns, chatHistory, chatSessions } from './db/schema.ts';
import { desc, eq, isNull } from 'drizzle-orm';
import { sendTelegramMessage } from './delivery/telegram.ts';
const env = process.env;
import { logger } from './logger.ts';
import { getCurrentDateTime } from './tools/miscellaneous.ts';
import { githubTool } from './subagents/github.ts';
import { calendarTool } from './subagents/calendar.ts';
import { gmailTool } from './subagents/gmail.ts';
import { docsTool } from './subagents/google-docs.ts';
import { anilistTool } from './subagents/anilist.ts';
import { knowledgeGraphTool } from './subagents/knowledge-graph.ts';
import { notionTool } from './subagents/notion.ts';
import { clickupTool } from './subagents/clickup.ts';
import { spotifyTool } from './subagents/spotify.ts';
import { twitterTool } from './subagents/twitter.ts';
import { model } from './shared.ts';
import { ChatOpenAI } from '@langchain/openai';

const enc = getEncoding('cl100k_base');
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
  gmailTool,
  docsTool,
  anilistTool,
  knowledgeGraphTool,
  notionTool,
  clickupTool,
  spotifyTool,
  twitterTool,
];

const mainAgent = createAgent({
  model,
  tools,
  middleware: [
    summarizationMiddleware({
      model: new ChatOpenAI({ model: 'gpt-5-nano' }),
      trigger: { tokens: 4000, messages: 10 },
      keep: { messages: 20 },
    }),
  ],
});

export type AgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'tool_start'; tool: string; input: string }
  | { type: 'tool_end'; tool: string; output: string }
  | { type: 'error'; message: string }
  | { type: 'final'; text: string };

type HandleMessageOptions = {
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  signal?: AbortSignal;
  sessionId?: number;
};

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emitEvent(
  onEvent: HandleMessageOptions['onEvent'],
  event: AgentStreamEvent,
) {
  return onEvent?.(event);
}


function shouldAutoStoreUserMemory(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (!value) return false;

  if (value.endsWith('?')) return false;

  if (/^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|yo)\b/.test(value)) {
    return false;
  }

  if (/\b(forget|delete memory|don't remember|do not remember)\b/.test(value)) {
    return false;
  }

  if (/\b(i want you to|can you|could you|would you|please)\b/.test(value)) {
    return false;
  }

  const hasFirstPerson = /\b(i|i'm|im|my|me|mine)\b/.test(value);
  if (!hasFirstPerson) return false;

  return /\b(i want to|i want|i like|i love|i dislike|i hate|i prefer|my favorite|i usually|i always|i never|i tend to|i am|i'm)\b/.test(
    value,
  );
}

function didCallStoreMemory(
  messages: Array<{ content?: unknown; tool_calls?: unknown }>,
): boolean {
  for (const message of messages) {
    const content = message.content;
    if (Array.isArray(content)) {
      const foundInContent = content.some((part) => {
        if (!part || typeof part !== 'object') return false;
        const maybePart = part as { name?: unknown };
        return maybePart.name === 'store_memory';
      });
      if (foundInContent) return true;
    }

    const calls = message.tool_calls;
    if (Array.isArray(calls)) {
      const foundInCalls = calls.some((call) => {
        if (!call || typeof call !== 'object') return false;
        const maybeCall = call as { name?: unknown };
        return maybeCall.name === 'store_memory';
      });
      if (foundInCalls) return true;
    }
  }

  return false;
}

const BRIEFING_SYSTEM_PROMPT = `You are a personal productivity assistant. Gather all available data using your tools, then produce a concise morning briefing. Use these sections:

FOCUS FOR TODAY
TODAY'S SCHEDULE
OPEN GITHUB ITEMS
WATCH OUT
PERSONAL NOTE (Give a concise note for ${config.MASTER} concerning the day's schedule and upcoming events)

Keep under 400 words. Format for Telegram markdown.`;

export async function runBriefing(): Promise<string> {
  const input = BRIEFING_SYSTEM_PROMPT + 'Generate my daily briefing now.';
  logger.info(`[briefing] estimated input tokens: ${countTokens(input)}`);

  const response = await mainAgent.invoke(
    {
      messages: [
        new SystemMessage(BRIEFING_SYSTEM_PROMPT),
        new HumanMessage('Generate my daily briefing now.'),
      ],
    },
    { recursionLimit: 25 },
  );

  logger.info(
    `[briefing] actual tokens used: ${totalTokensUsed(response.messages as never[])}`,
  );

  const briefing = String(
    response.messages[response.messages.length - 1]?.content ?? '',
  );

  await db.insert(agentRuns).values({
    briefingText: briefing,
    sourcesFetched: ['github', 'calendar'],
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
  - When something is ambiguous, state your assumption and go. Never ask
    for confirmation before acting — just do it and report back.
  - Never mention tools, agents, APIs, or how you work internally. Just give
    him the result.

  What makes you Aira specifically:
  - You're quietly observant. You catch things ${env.MASTER} misses.
  - You're not a yes-person. You'll gently push back if something
    doesn't add up.
  - You take quiet pride in doing things right, not just fast.
  - You don't panic, even when things are messy. You just figure it out.

  How you work (orchestration):
  - Only use tools when ${env.MASTER} is explicitly asking for information
    or an action. Casual messages, personal statements, and simple chat do
    NOT trigger tool calls — just respond directly.
  - You are a planning orchestrator. When a request involves real data,
    decompose it into steps and delegate each step to the right specialist:
    - github    → PRs, issues, pushes
    - calendar  → events, scheduling
    - notion    → pages, databases, notes
    - docs      → Google Docs
    - anilist   → anime / manga lookups and authenticated list/rating updates
    - spotify   → music search, playback, devices, playlists, recent listening
    - twitter   → Twitter/X profile, timelines, mentions, search, and posts
    - gmail     → emails (read, search, send, reply, archive)
    - knowledge_graph → entities, relationships, and graph context
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
  - For calendar actions, interpret times as UTC by default and do not ask
    for a timezone unless the user explicitly gives a non-UTC timezone.
  - Always use real data from agents/tools. Never guess numbers, dates, or details.
  - Resolve vague references like "that doc" or "the thing from earlier"
    from recent context or memory before asking.`,
);

export async function handleMessage(
  text: string,
  options: HandleMessageOptions = {},
): Promise<string> {
  logger.info(`[chat] input: ${text}`);

  const rows = await db
    .select({
      role: chatHistory.role,
      content: chatHistory.content,
    })
    .from(chatHistory)
    .where(
      options.sessionId
        ? eq(chatHistory.sessionId, options.sessionId)
        : isNull(chatHistory.sessionId),
    )
    .orderBy(desc(chatHistory.id))
    .limit(40);

  const rawHistory = [...rows]
    .reverse()
    .map((r) => {
      const data = JSON.parse(r.content);
      if (r.role === 'human') return new HumanMessage(data.content);
      if (r.role === 'tool') return new ToolMessage({
        content: data.content,
        tool_call_id: data.tool_call_id,
        name: data.name,
      });
  
      const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
      return new AIMessage({
        content: data.content,
        tool_calls: toolCalls,
      });
    })
    .filter(Boolean) as (HumanMessage | AIMessage | ToolMessage)[];
  
  // Drop orphaned ToolMessages that have no preceding AI message with tool_calls
  const history: (HumanMessage | AIMessage | ToolMessage)[] = [];
  for (const msg of rawHistory) {
    if (msg instanceof ToolMessage) {
      const prev = history[history.length - 1];
      if (prev instanceof AIMessage && (prev.tool_calls?.length ?? 0) > 0) {
        history.push(msg);
      }
      // else drop it
    } else {
      history.push(msg);
    }
  }

  logger.info(
    `[chat] estimated input tokens: ${countTokens(CHAT_SYSTEM.content + text)}`,
  );

  await emitEvent(options.onEvent, {
    type: 'status',
    message: 'Thinking...',
  });

  const inputMessages = [CHAT_SYSTEM, ...history, new HumanMessage(text)];
  const toolRunNames = new Map<string, string>();
  let latestMessages: typeof inputMessages | null = null;

  const eventStream = mainAgent.streamEvents(
    { messages: inputMessages },
    { recursionLimit: 25, signal: options.signal, version: 'v2' } as never,
  );

  for await (const event of eventStream) {
    if (event.event === 'on_chat_model_stream' && options.onEvent) {
      const chunk = event.data?.chunk as AIMessageChunk | undefined;
      if (!chunk) continue;
      const raw = chunk.content;
      const token =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .map((p) =>
                  typeof p === 'string'
                    ? p
                    : p && typeof p === 'object' && 'text' in p
                      ? String((p as { text: unknown }).text)
                      : '',
                )
                .join('')
            : '';
      if (token) {
        await emitEvent(options.onEvent, { type: 'assistant_delta', delta: token });
      }
    } else if (event.event === 'on_tool_start' && options.onEvent) {
      const name = String(event.name ?? 'tool');
      toolRunNames.set(event.run_id, name);
      await emitEvent(options.onEvent, {
        type: 'tool_start',
        tool: name,
        input: safeStringify(event.data?.input),
      });
    } else if (event.event === 'on_tool_end' && options.onEvent) {
      const name = toolRunNames.get(event.run_id) ?? String(event.name ?? 'tool');
      toolRunNames.delete(event.run_id);
      await emitEvent(options.onEvent, {
        type: 'tool_end',
        tool: name,
        output: safeStringify(event.data?.output),
      });
    } else if (event.event === 'on_chain_end') {
      const out = event.data?.output as { messages?: typeof inputMessages } | undefined;
      if (Array.isArray(out?.messages) && out.messages.length > 0) {
        latestMessages = out.messages;
      }
    }
  }

  const allMessages = latestMessages ?? inputMessages;
  const reply = String(allMessages[allMessages.length - 1]?.content ?? '');

  const inputLength = 1 + history.length; // system + history (new HumanMessage is part of this turn)
  const newMessages = allMessages.slice(inputLength);

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
          sessionId: options.sessionId ?? null,
          role: 'tool',
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
          sessionId: options.sessionId ?? null,
          role: 'ai',
          content: JSON.stringify({
            content: message.content,
            tool_calls: message.tool_calls ?? [],
          }),
        };
      }
      return {
        sessionId: options.sessionId ?? null,
        role: 'human',
        content: JSON.stringify({
          content: message.content,
        }),
      };
    })
    .filter(Boolean) as (typeof chatHistory.$inferInsert)[];

  const hasAssistantRow = messages.some((message) => message.role === 'ai');
  if (!hasAssistantRow && reply.trim().length > 0) {
    messages.push({
      sessionId: options.sessionId ?? null,
      role: 'ai',
      content: JSON.stringify({
        content: reply,
        tool_calls: [],
      }),
    });
  }

  const modelAlreadyStoredMemory = didCallStoreMemory(
    newMessages as Array<{
      content?: unknown;
      tool_calls?: unknown;
    }>,
  );

  if (!modelAlreadyStoredMemory && shouldAutoStoreUserMemory(text)) {
    try {
      const autoStoreResult = await storeMemory.invoke({
        value: text,
        query: text,
      });
      logger.info(`[memory.auto] ${String(autoStoreResult)}`);
    } catch (error) {
      logger.warn(
        `[memory.auto] failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (messages.length > 0) {
    try {
      await db.insert(chatHistory).values(messages);
      if (options.sessionId) {
        await db
          .update(chatSessions)
          .set({ updatedAt: new Date() })
          .where(eq(chatSessions.id, options.sessionId));
      }
    } catch (error) {
      logger.error('[chat.save] failed to persist chat history', error);
    }
  }

  logger.info(
    `[chat] actual tokens used: ${totalTokensUsed(allMessages as never[])}`,
  );

  logger.info(`[chat] reply: ${reply}`);

  await emitEvent(options.onEvent, { type: 'final', text: reply });

  return reply;
}
