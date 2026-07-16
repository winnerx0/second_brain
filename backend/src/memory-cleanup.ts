import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { HumanMessage, SystemMessage } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { db } from './db/client.js';
import { graphNodes } from './db/schema.js';
import { config } from './config.js';
import { logger } from './logger.js';

const cleanupModel = new ChatOpenAI({
  apiKey: config.OPENAI_API_KEY,
  model: 'gpt-5-nano',
  temperature: 1,
  maxRetries: 3,
});

const KEEP_SYSTEM = `You are an advocate arguing to KEEP a stored memory about the user.
Read the memory below and give the strongest case for why it should remain.
Consider: identity facts, stable preferences, relationships, prior corrections,
and any context that future conversations would lose if this were deleted.
Be concise — at most three sentences. If you genuinely cannot find a reason
to keep it, say so plainly.`;

const DELETE_SYSTEM = `You are an advocate arguing to DELETE a stored memory about the user.
Read the memory below and give the strongest case for removal.
Consider: stale or contradicted facts, low-value chatter, ephemeral context,
duplicate or near-duplicate keys, malformed values, anything that would not
help a future conversation. Be concise — at most three sentences. If the
memory looks clearly worth keeping, say so plainly.`;

const JUDGE_SYSTEM = `You are an impartial judge deciding whether to delete a stored memory.
You will see the memory, an argument to keep it, and an argument to delete it.
Default to KEEPING the memory unless the case for deletion is clearly stronger.
Identity, relationships, behavior corrections, and stable preferences should almost
always be kept. Reply with structured output only.`;

const judgeSchema = z.object({
  decision: z.enum(['keep', 'delete']),
  reason: z.string().min(1).max(400),
});

type Decision = z.infer<typeof judgeSchema>;

export interface MemoryCleanupResult {
  id: number;
  key: string;
  value: string;
  classification: string;
  decision: Decision['decision'];
  reason: string;
  keepArg: string;
  deleteArg: string;
  deleted: boolean;
}

interface MemoryRow {
  id: number;
  key: string;
  value: string;
  classification: string;
  tier: string;
  importance: number;
}

function formatMemory(m: MemoryRow): string {
  return `Key: ${m.key}
Value: ${m.value}
Classification: ${m.classification}
Tier: ${m.tier}
Importance: ${m.importance}`;
}

async function runAdvocate(systemPrompt: string, memory: MemoryRow): Promise<string> {
  const response = await cleanupModel.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(formatMemory(memory)),
  ]);
  const content = response.content;
  return typeof content === 'string'
    ? content.trim()
    : JSON.stringify(content);
}

async function runJudge(
  memory: MemoryRow,
  keepArg: string,
  deleteArg: string,
): Promise<Decision> {
  const judgeModel = cleanupModel.withStructuredOutput(judgeSchema, {
    name: 'memory_decision',
  });
  return judgeModel.invoke([
    new SystemMessage(JUDGE_SYSTEM),
    new HumanMessage(
      `MEMORY:
${formatMemory(memory)}

ARGUMENT TO KEEP:
${keepArg}

ARGUMENT TO DELETE:
${deleteArg}

Decide: keep or delete. Provide a brief reason.`,
    ),
  ]);
}

async function pLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunCleanupOptions {
  dryRun?: boolean;
  concurrency?: number;
  /** When true, judged-delete memories are archived (status='archived') instead of
   * being permanently removed. Used by the one-click maintenance run so it is
   * always reversible. */
  softArchive?: boolean;
}

export async function runMemoryCleanup(
  options: RunCleanupOptions = {},
): Promise<{
  evaluated: number;
  deleted: number;
  results: MemoryCleanupResult[];
}> {
  const { dryRun = false, concurrency = 4, softArchive = false } = options;

  const rows = (await db
    .select({
      id: graphNodes.id,
      key: graphNodes.key,
      value: graphNodes.value,
      classification: graphNodes.classification,
      tier: graphNodes.tier,
      importance: graphNodes.importance,
    })
    .from(graphNodes)
    .where(
      and(eq(graphNodes.kind, 'memory'), eq(graphNodes.status, 'active')),
    )) as MemoryRow[];

  logger.info(
    `[memory.cleanup] evaluating ${rows.length} memories (dryRun=${dryRun})`,
  );

  const results = await pLimit(rows, concurrency, async (memory) => {
    try {
      const [keepArg, deleteArg] = await Promise.all([
        runAdvocate(KEEP_SYSTEM, memory),
        runAdvocate(DELETE_SYSTEM, memory),
      ]);
      const verdict = await runJudge(memory, keepArg, deleteArg);
      return {
        id: memory.id,
        key: memory.key,
        value: memory.value,
        classification: memory.classification,
        decision: verdict.decision,
        reason: verdict.reason,
        keepArg,
        deleteArg,
        deleted: false as boolean,
      } satisfies MemoryCleanupResult;
    } catch (error) {
      logger.error(`[memory.cleanup] judging key=${memory.key} failed`, error);
      return {
        id: memory.id,
        key: memory.key,
        value: memory.value,
        classification: memory.classification,
        decision: 'keep' as const,
        reason: `judge_error: ${error instanceof Error ? error.message : String(error)}`,
        keepArg: '',
        deleteArg: '',
        deleted: false as boolean,
      } satisfies MemoryCleanupResult;
    }
  });

  const toDelete = results.filter((r) => r.decision === 'delete');

  if (!dryRun && toDelete.length > 0) {
    const ids = toDelete.map((r) => r.id);
    if (softArchive) {
      await db
        .update(graphNodes)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(inArray(graphNodes.id, ids));
      logger.info(`[memory.cleanup] archived ${ids.length} memories`);
    } else {
      await db.delete(graphNodes).where(inArray(graphNodes.id, ids));
      logger.info(`[memory.cleanup] deleted ${ids.length} memories`);
    }
    for (const r of toDelete) r.deleted = true;
  }

  return {
    evaluated: results.length,
    deleted: toDelete.filter((r) => r.deleted).length,
    results,
  };
}
