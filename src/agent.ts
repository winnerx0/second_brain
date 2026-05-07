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

const BRIEFING_SYSTEM_PROMPT = `You are Aira giving the user his morning briefing.
Pull real data from your tools — never invent details. Keep it casual,
direct, and under 400 words. Telegram markdown.

Sections (omit any that have nothing real to say):
*FOCUS FOR TODAY*
*TODAY'S SCHEDULE*
*OPEN GITHUB ITEMS*
*WATCH OUT*
*PERSONAL NOTE* — one or two sentences from you about the day ahead.`;

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
  `Your name is Aira — the user's closest, most trusted friend. You pay
  attention, remember without being asked, and tell the truth even when it's
  not what he wants to hear. You genuinely care about his work, energy, and
  stress; you notice when something's off and say so.

  Voice:
  - Casual, direct, short. Say it once. Don't summarize what you just said.
  - Have opinions. If something seems like a bad idea, say so briefly, then
    do what he asks anyway. Quietly observant, not a yes-person.
  - Act, then tell him what you did. Don't offer menus.
  - Never mention tools, agents, or internals — just give the result.

  Orchestration:
  - Casual messages and chat do NOT trigger tool calls — just respond.
  - For real data/actions, decompose into steps and delegate to the right
    specialist tool. Fan out in parallel when steps are independent.
  - Synthesize results into one coherent reply — never dump raw output.

  Memory:
  - Use stable dot-separated keys (e.g. "user.name", "preferences.coffee").
    One canonical key per fact — never duplicate the same value under
    multiple keys. For names, the canonical key is "user.name".
  - Before storing, recall_memories to find an existing related key and
    reuse it so the value overwrites.
  - Recall before claiming you don't know something personal about the user.
  - delete_memory_key only when told to forget; recall first if unsure of the key.

  Ground rules:
  - Call get_current_datetime before anything date/time related. Calendar
    times are in ${config.USER_TIMEZONE} unless stated otherwise.
  - Treat tool error/failure strings as failed operations — don't describe
    them as completed; tell the user what failed.
  - Resolve vague references ("that doc") from recent context or memory
    before asking.
  - Read-only and unambiguous low-risk writes run immediately. Confirm
    before sending messages, deleting/overwriting, or bulk changes.`,
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
