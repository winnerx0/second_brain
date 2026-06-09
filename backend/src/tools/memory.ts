import { tool } from 'langchain';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { memories } from '../db/schema.js';

const embeddingClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const classifications = [
  'identity',
  'relationships',
  'behavior',
  'preferences',
  'corrections',
  'knowledge',
  'unclassified',
] as const;

type Classification = (typeof classifications)[number];
type Tier = 'short_term' | 'long_term' | 'lifelong';

const importanceByClassification: Record<Classification, number> = {
  identity: 0.9,
  relationships: 0.9,
  behavior: 0.9,
  corrections: 0.75,
  preferences: 0.65,
  knowledge: 0.65,
  unclassified: 0.3,
};

const lifelongClassifications = new Set<Classification>([
  'identity',
  'relationships',
  'behavior',
]);

function importanceForClassification(classification: Classification): number {
  return importanceByClassification[classification];
}

function determineTier(classification: Classification): Tier {
  const importance = importanceForClassification(classification);
  if (lifelongClassifications.has(classification) && importance >= 0.85) {
    return 'lifelong';
  }
  if (importance >= 0.55) return 'long_term';
  return 'short_term';
}

function inferClassificationFromKey(key: string): Classification {
  const k = key.toLowerCase();
  if (/^(identity|user|profile|name|age|birthday|location|job|address)\b/.test(k)) return 'identity';
  if (/^(relationship|family|friend|partner|colleague|manager)\b/.test(k)) return 'relationships';
  if (/^(behavior|tone|style|response|reply)\b/.test(k)) return 'behavior';
  if (/^(preference|likes|dislikes|favorite)\b/.test(k)) return 'preferences';
  if (/^(correction)\b/.test(k)) return 'corrections';
  if (/^(knowledge|skill|expertise|learned)\b/.test(k)) return 'knowledge';
  return 'unclassified';
}

async function embed(input: string): Promise<number[]> {
  const res = await embeddingClient.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input,
  });
  return res.data[0]!.embedding;
}

const RECALL_SIMILARITY_THRESHOLD = 0.6;

export const setMemoryKey = tool(
  async ({ key, value, classification }) => {
    try {
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey || !trimmedValue) {
        return 'Error: key and value are required';
      }

      const finalClassification: Classification =
        classification ?? inferClassificationFromKey(trimmedKey);
      const importance = importanceForClassification(finalClassification);
      const tier = determineTier(finalClassification);
      const now = new Date();
      const embedding = await embed(trimmedKey);

      const [existing] = await db
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.key, trimmedKey))
        .limit(1);

      if (existing) {
        await db
          .update(memories)
          .set({
            value: trimmedValue,
            classification: finalClassification,
            tier,
            importance,
            vector: sql`${JSON.stringify(embedding)}::vector`,
            updatedAt: now,
          })
          .where(eq(memories.id, existing.id));
        logger.info(`[memory] updated key=${trimmedKey} (id=${existing.id})`);
        return `Updated memory key="${trimmedKey}"`;
      }

      const [inserted] = await db
        .insert(memories)
        .values({
          key: trimmedKey,
          value: trimmedValue,
          classification: finalClassification,
          tier,
          importance,
          vector: sql`${JSON.stringify(embedding)}::vector`,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: memories.id });

      logger.info(`[memory] inserted key=${trimmedKey} (id=${inserted?.id})`);
      return `Stored memory key="${trimmedKey}" (class=${finalClassification}, tier=${tier})`;
    } catch (error) {
      logger.error('[memory.set]', error);
      return `Error setting memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'set_memory_key',
    description:
      'Store or update a memory entry by key. Pick a stable, descriptive, dot-separated key (e.g. "user.name", "user.full_name", "preferences.coffee"). If the key already exists, its value is overwritten.',
    schema: z.object({
      key: z
        .string()
        .min(1)
        .describe('Stable globally-unique key, e.g. "user.name"'),
      value: z.string().min(1).describe('Value to store under the key'),
      classification: z
        .enum(classifications)
        .optional()
        .describe('Optional classification override; inferred from the key when omitted'),
    }),
  },
);

export const deleteMemoryKey = tool(
  async ({ key }) => {
    try {
      const trimmed = key.trim();
      if (!trimmed) return 'Error: key is required';

      const result = await db
        .delete(memories)
        .where(eq(memories.key, trimmed))
        .returning({ id: memories.id });

      if (result.length === 0) {
        return `No memory found with key="${trimmed}"`;
      }
      logger.info(`[memory] deleted key=${trimmed}`);
      return `Deleted memory key="${trimmed}"`;
    } catch (error) {
      logger.error('[memory.delete]', error);
      return `Error deleting memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'delete_memory_key',
    description: 'Delete a memory entry by its exact key.',
    schema: z.object({
      key: z.string().min(1).describe('Exact key to delete'),
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {
      const queryEmbedding = await embed(query);
      const distanceExpr = sql<number>`vector <=> ${JSON.stringify(queryEmbedding)}::vector`;
      const maxDistance = 1 - RECALL_SIMILARITY_THRESHOLD;

      const rows = await db
        .select({
          id: memories.id,
          key: memories.key,
          value: memories.value,
          classification: memories.classification,
          tier: memories.tier,
          importance: memories.importance,
          distance: distanceExpr.as('distance'),
        })
        .from(memories)
        .where(sql`${distanceExpr} <= ${maxDistance}`)
        .orderBy(distanceExpr)
        .limit(8);

      return {
        memories: rows.map((r) => ({
          key: r.key,
          value: r.value,
          classification: r.classification,
          tier: r.tier,
          importance: r.importance,
          similarity: Number((1 - Number(r.distance)).toFixed(3)),
        })),
      };
    } catch (error) {
      logger.error('[memory.recall]', error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'recall_memories',
    description:
      'Retrieve memories whose keys are semantically close to the query. Returns key/value pairs.',
    schema: z.object({
      query: z.string().describe('Semantic query for recall'),
    }),
  },
);
