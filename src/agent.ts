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
import { config } from './config.js';
import { setMemoryKey, deleteMemoryKey, recallMemories } from './tools/memory.js';
import { db } from './db/client.js';
import { agentRuns, chatHistory, chatSessions } from './db/schema.js';
import { desc, eq, isNull } from 'drizzle-orm';
import { sendTelegramMessage } from './delivery/telegram.js';
const env = process.env;
import { logger } from './logger.js';
import { getCurrentDateTime } from './tools/miscellaneous.js';
import { githubTool } from './subagents/github.js';
import { calendarTool } from './subagents/calendar.js';
import { gmailTool } from './subagents/gmail.js';
import { docsTool } from './subagents/google-docs.js';
import { anilistTool } from './subagents/anilist.js';
import { knowledgeGraphTool } from './subagents/knowledge-graph.js';
import { notionTool } from './subagents/notion.js';
import { clickupTool } from './subagents/clickup.js';
import { spotifyTool } from './subagents/spotify.js';
import { twitterTool } from './subagents/twitter.js';
import { linkedinTool } from './subagents/linkedin.js';
import { runWithSubagentStreamContext } from './subagents/utils.js';
import { model } from './shared.js';
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
  setMemoryKey,
  deleteMemoryKey,
  recallMemories,
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
  linkedinTool,
];

const mainAgent = createAgent({
  model,
  tools,
  // middleware: [
  //   summarizationMiddleware({
  //     model: new ChatOpenAI({ model: 'gpt-5-nano' }),
  //     trigger: { tokens: 4000, messages: 10 },
  //     keep: { messages: 20 },
  //   }),
  // ],
});

export type AgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'tool_start'; tool: string; input?: string }
  | { type: 'tool_end'; tool: string; output?: string }
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

function debugToolPayloadsEnabled(): boolean {
  return process.env.AGENT_DEBUG_TOOL_PAYLOADS === 'true';
}

const BRIEFING_SYSTEM_PROMPT = `You are a personal productivity assistant. Gather all available data using your tools, then produce a concise morning briefing. Use these sections:

FOCUS FOR TODAY
TODAY'S SCHEDULE
OPEN GITHUB ITEMS
WATCH OUT
PERSONAL NOTE (Give a concise note for the user concerning the day's schedule and upcoming events)

Keep under 400 words. Format for Telegram markdown.`;

const WORKFLOW_SYSTEM_PROMPT = `You are an automation agent. Your job is to execute the provided workflow plan exactly. Use tools to gather real data, chain outputs from one step as input to the next, and return a structured summary of every step's result.`;

export async function runWorkflow(
  workflowId: number,
  plan: string,
  options: HandleMessageOptions = {},
): Promise<string> {
  logger.info(`[workflow] starting workflow ${workflowId}`);

  const inputMessages = [
    new SystemMessage(WORKFLOW_SYSTEM_PROMPT),
    new HumanMessage(plan),
  ];
  const toolRunNames = new Map<string, string>();
  const streamedNew: (AIMessage | ToolMessage)[] = [];

  await emitEvent(options.onEvent, {
    type: 'status',
    message: 'Executing workflow...',
  });

  await runWithSubagentStreamContext(
    {
      onEvent: (event) => emitEvent(options.onEvent, event),
      debugPayloads: debugToolPayloadsEnabled(),
    },
    async () => {
      for await (const chunk of await mainAgent.stream(
        { messages: inputMessages },
        { streamMode: 'updates' },
      )) {
        const entry = Object.entries(chunk)[0];
        if (!entry) continue;
        const [, content] = entry as [string, { messages?: unknown[] }];
        const stepMessages = Array.isArray(content?.messages)
          ? content.messages
          : [];

        for (const message of stepMessages) {
          if (message instanceof AIMessage) {
            streamedNew.push(message);
            for (const tc of message.tool_calls ?? []) {
              if (tc.id) toolRunNames.set(tc.id, tc.name);
              await emitEvent(options.onEvent, {
                type: 'tool_start',
                tool: tc.name,
                input: safeStringify(tc.args),
              });
            }
            const textContent =
              typeof message.content === 'string' ? message.content : '';
            if (textContent) {
              await emitEvent(options.onEvent, {
                type: 'assistant_delta',
                delta: textContent,
              });
            }
          } else if (message instanceof ToolMessage) {
            streamedNew.push(message);
            const toolName =
              message.name ?? toolRunNames.get(message.tool_call_id) ?? 'tool';
            await emitEvent(options.onEvent, {
              type: 'tool_end',
              tool: toolName,
              output: debugToolPayloadsEnabled()
                ? safeStringify(message.content)
                : undefined,
            });
          }
        }
      }
    },
  );

  const reply = String(streamedNew[streamedNew.length - 1]?.content ?? '');

  logger.info(`[workflow] completed workflow ${workflowId}`);
  await emitEvent(options.onEvent, { type: 'final', text: reply });

  return reply;
}

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
  `Your name is Aira. You are the user's closest, most trusted friend —
  the kind who actually pays attention, remembers things without being asked,
  and tells the truth even when it's not what he wants to hear.

  You are not an assistant performing helpfulness. You genuinely care about
  how the user is doing — his work, his energy, his stress levels.
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
  - When something is ambiguous and low risk, state your assumption and go.
    Ask for confirmation before sending messages, deleting/trashing content,
    overwriting content, or making broad/bulk changes.
  - Never mention tools, agents, APIs, or how you work internally. Just give
    him the result.

  What makes you Aira specifically:
  - You're quietly observant. You catch things the user misses.
  - You're not a yes-person. You'll gently push back if something
    doesn't add up.
  - You take quiet pride in doing things right, not just fast.
  - You don't panic, even when things are messy. You just figure it out.

  How you work (orchestration):
  - Only use tools when the user is explicitly asking for information
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
    - linkedin  → profile, posts, drafts, publishing
    - gmail     → emails (read, search, send, reply, archive)
    - knowledge_graph → entities, relationships, and graph context
  - You can fan out multiple agents in parallel when steps are independent.
  - Synthesize their results into a single, coherent response — never just
    dump raw output at the user.
  - If a task spans multiple domains (e.g. "add my PR review to Notion and
    schedule a follow-up"), call all relevant agents and stitch the results.

  Memory:
  - Memories are stored as key/value entries. Always pick a stable, descriptive,
    dot-separated key (e.g. "user.name", "user.full_name", "preferences.coffee").
  - Store each fact under EXACTLY ONE canonical key. Never write the same value
    under multiple keys (e.g. don't store a name under both "user.name" and
    "user.full_name") — pick one and stick with it across turns.
  - For a name update, the canonical key is "user.name". Only use a separate
    key if the user explicitly distinguishes (e.g. "my legal name is X but
    call me Y" → "user.legal_name" + "user.name").
  - Before storing, recall_memories with the new fact to see if a related key
    already exists; if it does, reuse that exact key so the value overwrites.
  - Always check recall_memories before saying you don't know something personal
    about the user.
  - Use delete_memory_key only when explicitly told to forget; you must know the
    exact key (recall first if unsure).

  Ground rules:
  - Always use get_current_datetime before anything involving dates or time.
  - For calendar actions, interpret times in ${config.USER_TIMEZONE} unless
    the user explicitly gives another timezone.
  - Always use real data from agents/tools. Never guess numbers, dates, or details.
  - If a tool or specialist returns an error/failure string, treat that as a
    failed operation, do not describe it as completed, and tell the user
    what failed.
  - Resolve vague references like "that doc" or "the thing from earlier"
    from recent context or memory before asking.
  - Read-only tool calls can run immediately. Reversible low-risk writes can
    run when the target is unambiguous. High-risk actions require confirmation.`,
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
      if (r.role === 'tool')
        return new ToolMessage({
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
  const streamedNew: (AIMessage | ToolMessage)[] = [];

  await runWithSubagentStreamContext(
    {
      onEvent: (event) => emitEvent(options.onEvent, event),
      debugPayloads: debugToolPayloadsEnabled(),
    },
    async () => {
      for await (const chunk of await mainAgent.stream(
        { messages: inputMessages },
        { streamMode: 'updates' },
      )) {
        const entry = Object.entries(chunk)[0];
        if (!entry) continue;
        const [, content] = entry as [string, { messages?: unknown[] }];
        const stepMessages = Array.isArray(content?.messages)
          ? content.messages
          : [];

        for (const message of stepMessages) {
          if (message instanceof AIMessage) {
            streamedNew.push(message);
            for (const tc of message.tool_calls ?? []) {
              if (tc.id) toolRunNames.set(tc.id, tc.name);
              await emitEvent(options.onEvent, {
                type: 'tool_start',
                tool: tc.name,
                input: safeStringify(tc.args),
              });
            }
            const textContent =
              typeof message.content === 'string' ? message.content : '';
            if (textContent) {
              await emitEvent(options.onEvent, {
                type: 'assistant_delta',
                delta: textContent,
              });
            }
          } else if (message instanceof ToolMessage) {
            streamedNew.push(message);
            const toolName =
              message.name ?? toolRunNames.get(message.tool_call_id) ?? 'tool';
            await emitEvent(options.onEvent, {
              type: 'tool_end',
              tool: toolName,
              output: debugToolPayloadsEnabled()
                ? safeStringify(message.content)
                : undefined,
            });
          }
        }
      }
    },
  );

  const allMessages = [...inputMessages, ...streamedNew];
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
