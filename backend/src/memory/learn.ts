import { z } from 'zod';
import { HumanMessage, SystemMessage } from 'langchain';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphNodes, graphEdges } from '../db/schema.js';
import { logger } from '../logger.js';
import { model } from '../shared.js';
import {
  embed,
  determineTier,
  inferClassificationFromKey,
  importanceForClassification,
  type Classification,
} from '../tools/memory.js';
import {
  ensureNode,
  normalizeName,
  resolveNodeId,
  NODE_KIND_VALUES,
  type NodeKind,
} from '../tools/knowledge-graph.js';

// The user (and the assistant) are implicit — facts about them are stored as memories,
// never as entity nodes. This prevents a synthetic "user" node + self-referential edges.
const SELF_TERMS = new Set([
  'user',
  'me',
  'i',
  'myself',
  'my',
  'the user',
  'you',
  'aira',
  'assistant',
]);

function isSelf(name: string): boolean {
  return SELF_TERMS.has(normalizeName(name));
}

// Two active memory nodes are treated as the same fact above this cosine similarity.
const DUPLICATE_SIMILARITY = 0.93;
// A correction supersedes an existing memory when they are at least this similar.
const SUPERSEDE_SIMILARITY = 0.82;
// Inferred edges below this confidence are discarded.
const MIN_EDGE_CONFIDENCE = 0.6;

function vec(embedding: number[]) {
  return sql`${JSON.stringify(embedding)}::vector`;
}

// ---------------------------------------------------------------------------
// 1. Auto-extract facts & entities from a finished conversation turn
// ---------------------------------------------------------------------------

const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        key: z
          .string()
          .describe('Stable dot-separated key, e.g. "user.name", "preferences.editor"'),
        value: z.string().describe('The fact to remember'),
        classification: z
          .enum([
            'identity',
            'relationships',
            'behavior',
            'preferences',
            'corrections',
            'knowledge',
            'unclassified',
          ])
          .describe('Best-fit classification for the fact'),
      }),
    )
    .describe('Durable personal facts worth remembering. Empty if nothing is durable.'),
  entities: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(NODE_KIND_VALUES),
      }),
    )
    .describe('Named entities (people, projects, documents, ...) mentioned.'),
  edges: z
    .array(
      z.object({
        subject: z.string(),
        relation: z.string().describe('Lowercase relation, e.g. works_on, manages, lives_in'),
        object: z.string(),
        evidence: z.string().optional(),
      }),
    )
    .describe('Relationships between the entities above.'),
  episodeSummary: z
    .string()
    .describe(
      'One short sentence summarizing what happened this turn, for a timeline. Empty if nothing notable.',
    ),
});

const EXTRACTOR_SYSTEM = `You extract durable knowledge from a single conversation turn.
Return only genuinely useful, stable facts about the user and their world — skip
chit-chat, transient state, and anything already obvious. Prefer canonical
dot-separated keys and one fact per memory.

Entities and edges describe the user's WORLD, not the user. NEVER create an entity
for the user (do not use "user", "me", "I", "you" as an entity name) and never use a
memory key (e.g. "user.name") as an entity. Only add entities for distinct named
people, projects, documents, tasks, decisions, or topics, and only add edges between
two such entities (e.g. "Priya" leads "Helios"). Facts about the user belong in
memories, not edges. If nothing is worth keeping, return empty arrays.`;

interface ConsolidateInput {
  userText: string;
  assistantText: string;
  sessionId?: number | null;
}

/**
 * Self-learn entry point. Extracts memories/entities/edges from the latest turn and
 * upserts them, deduping against what already exists. Designed to be called
 * fire-and-forget after handleMessage so it never blocks the chat response.
 */
export async function consolidateConversation(
  input: ConsolidateInput,
): Promise<{ memories: number; entities: number; edges: number }> {
  const result = { memories: 0, entities: 0, edges: 0 };
  // Provenance tag recorded on every node this turn produces.
  const source = input.sessionId ? `chat:session:${input.sessionId}` : 'chat';
  const learnedIds: number[] = [];
  try {
    const extractor = model.withStructuredOutput(extractionSchema, {
      name: 'extract_knowledge',
    });
    const extracted = await extractor.invoke([
      new SystemMessage(EXTRACTOR_SYSTEM),
      new HumanMessage(
        `User said:\n${input.userText}\n\nAssistant replied:\n${input.assistantText}`,
      ),
    ]);

    for (const m of extracted.memories) {
      const id = await upsertLearnedMemory(
        m.key,
        m.value,
        m.classification as Classification,
        source,
      );
      if (id) {
        result.memories += 1;
        learnedIds.push(id);
      }
    }

    const entityIds = new Map<string, number>();
    for (const e of extracted.entities) {
      if (isSelf(e.name)) continue; // the user is never an entity node
      try {
        const node = await ensureNode({ name: e.name, kind: e.kind as NodeKind, source });
        entityIds.set(normalizeName(e.name), node.id);
        learnedIds.push(node.id);
        result.entities += 1;
      } catch (error) {
        logger.error('[learn] ensureNode failed', error);
      }
    }

    for (const edge of extracted.edges) {
      // Skip self-referential edges — those facts already live as memories.
      if (isSelf(edge.subject) || isSelf(edge.object)) continue;
      try {
        // Only link endpoints that are real entities (extracted this turn or already
        // in the graph). Never fabricate filler 'other' nodes for unknown names.
        const fromId =
          entityIds.get(normalizeName(edge.subject)) ??
          (await resolveNodeId(edge.subject));
        const toId =
          entityIds.get(normalizeName(edge.object)) ??
          (await resolveNodeId(edge.object));
        if (!fromId || !toId || fromId === toId) continue;
        await upsertEdge(fromId, toId, edge.relation, {
          createdBy: 'agent',
          evidence: edge.evidence,
        });
        result.edges += 1;
      } catch (error) {
        logger.error('[learn] edge insert failed', error);
      }
    }

    // Episodic memory: tie everything learned this turn to a dated episode node so
    // the graph carries a navigable timeline of "what happened when".
    if (extracted.episodeSummary?.trim() && learnedIds.length > 0) {
      await recordEpisode(extracted.episodeSummary.trim(), input.sessionId ?? null, source, learnedIds);
    }

    logger.info(
      `[learn] consolidated turn: +${result.memories} memories, +${result.entities} entities, +${result.edges} edges`,
    );
  } catch (error) {
    logger.error('[learn] consolidateConversation failed', error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 5. Episodic memory — a timeline node per session/day linking what was learned
// ---------------------------------------------------------------------------

async function recordEpisode(
  summary: string,
  sessionId: number | null,
  source: string,
  learnedIds: number[],
) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = sessionId ? `episode.session.${sessionId}` : `episode.date.${day}`;
    const now = new Date();

    const [existing] = await db
      .select({ id: graphNodes.id, value: graphNodes.value })
      .from(graphNodes)
      .where(eq(graphNodes.key, key))
      .limit(1);

    let episodeId: number;
    if (existing) {
      // Append the new summary, keeping the episode log to its last ~12 lines.
      const lines = `${existing.value ?? ''}\n- ${summary}`
        .split('\n')
        .filter(Boolean)
        .slice(-12);
      await db
        .update(graphNodes)
        .set({ value: lines.join('\n'), updatedAt: now })
        .where(eq(graphNodes.id, existing.id));
      episodeId = existing.id;
    } else {
      const name = sessionId ? `Session ${sessionId}` : `Episode ${day}`;
      const embedding = await embed(`${name}: ${summary}`);
      const [created] = await db
        .insert(graphNodes)
        .values({
          kind: 'episode',
          name,
          normalizedName: name.toLowerCase(),
          key,
          value: `- ${summary}`,
          importance: 0.5,
          status: 'active',
          source,
          vector: vec(embedding),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: graphNodes.id });
      episodeId = created!.id;
    }

    // Link the episode to every node learned this turn.
    for (const id of learnedIds) {
      if (id === episodeId) continue;
      await upsertEdge(episodeId, id, 'records', { createdBy: 'agent' });
    }
  } catch (error) {
    logger.error('[learn] recordEpisode failed', error);
  }
}

/** Insert a learned memory unless a near-duplicate already exists. Returns the node id
 * when stored/updated, or null when skipped as a duplicate. */
async function upsertLearnedMemory(
  rawKey: string,
  rawValue: string,
  classification: Classification,
  source: string,
): Promise<number | null> {
  const key = rawKey.trim();
  const value = rawValue.trim();
  if (!key || !value) return null;

  const cls = classification ?? inferClassificationFromKey(key);
  const importance = importanceForClassification(cls);
  const tier = determineTier(cls);
  const embedding = await embed(key);
  const now = new Date();

  // Exact key already present → refresh value.
  const [existing] = await db
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(and(eq(graphNodes.kind, 'memory'), eq(graphNodes.key, key)))
    .limit(1);

  if (existing) {
    await db
      .update(graphNodes)
      .set({ value, classification: cls, tier, importance, status: 'active', updatedAt: now })
      .where(eq(graphNodes.id, existing.id));
    if (cls === 'corrections') await supersedeContradicted(existing.id, embedding);
    return existing.id;
  }

  // Near-duplicate (different key, same meaning) → skip to avoid graph bloat.
  const distance = sql<number>`vector <=> ${vec(embedding)}`;
  const [dup] = await db
    .select({ id: graphNodes.id, distance: distance.as('distance') })
    .from(graphNodes)
    .where(
      and(eq(graphNodes.kind, 'memory'), eq(graphNodes.status, 'active'), sql`vector IS NOT NULL`),
    )
    .orderBy(distance)
    .limit(1);
  if (dup && 1 - Number(dup.distance) >= DUPLICATE_SIMILARITY) return null;

  const [inserted] = await db
    .insert(graphNodes)
    .values({
      kind: 'memory',
      name: key,
      normalizedName: key.toLowerCase(),
      key,
      value,
      classification: cls,
      tier,
      importance,
      status: 'active',
      source,
      // Auto-learned facts are slightly less certain than ones the user dictated.
      confidence: 0.8,
      vector: vec(embedding),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: graphNodes.id });

  if (cls === 'corrections' && inserted) {
    await supersedeContradicted(inserted.id, embedding);
  }
  return inserted?.id ?? null;
}

// ---------------------------------------------------------------------------
// 4. Learn from corrections — supersede the memory a correction contradicts
// ---------------------------------------------------------------------------

async function supersedeContradicted(correctionId: number, embedding: number[]) {
  const distance = sql<number>`vector <=> ${vec(embedding)}`;
  const [target] = await db
    .select({ id: graphNodes.id, distance: distance.as('distance') })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.kind, 'memory'),
        eq(graphNodes.status, 'active'),
        ne(graphNodes.id, correctionId),
        sql`vector IS NOT NULL`,
      ),
    )
    .orderBy(distance)
    .limit(1);

  if (!target || 1 - Number(target.distance) < SUPERSEDE_SIMILARITY) return;

  await db
    .update(graphNodes)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(eq(graphNodes.id, target.id));
  await upsertEdge(correctionId, target.id, 'corrects', { createdBy: 'agent' });
  logger.info(`[learn] correction ${correctionId} superseded memory ${target.id}`);
}

// ---------------------------------------------------------------------------
// 2. Reinforce / decay importance over time
// ---------------------------------------------------------------------------

/**
 * Lower importance for memory nodes that have not been recalled recently, then
 * recompute their tier. Lifelong classifications are floored and never demoted.
 */
export async function decayImportance(
  opts: { idleDays?: number; amount?: number } = {},
): Promise<{ decayed: number }> {
  const idleDays = opts.idleDays ?? 14;
  const amount = opts.amount ?? 0.05;

  const rows = await db
    .select({
      id: graphNodes.id,
      classification: graphNodes.classification,
      importance: graphNodes.importance,
    })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.kind, 'memory'),
        eq(graphNodes.status, 'active'),
        or(
          sql`${graphNodes.lastRecalledAt} IS NULL AND ${graphNodes.createdAt} < now() - ${`${idleDays} days`}::interval`,
          sql`${graphNodes.lastRecalledAt} < now() - ${`${idleDays} days`}::interval`,
        ),
      ),
    );

  let decayed = 0;
  for (const row of rows) {
    const cls = (row.classification ?? 'unclassified') as Classification;
    // Floor at half the base importance so durable facts never fade to nothing.
    const floor = importanceForClassification(cls) * 0.5;
    const next = Math.max(floor, row.importance - amount);
    if (next === row.importance) continue;
    await db
      .update(graphNodes)
      .set({ importance: next, tier: determineTier(cls), updatedAt: new Date() })
      .where(eq(graphNodes.id, row.id));
    decayed += 1;
  }
  logger.info(`[learn] decayed ${decayed} memories`);
  return { decayed };
}

// ---------------------------------------------------------------------------
// 3. Infer new edges between semantically related nodes
// ---------------------------------------------------------------------------

const relationSchema = z.object({
  related: z.boolean(),
  relation: z.string().describe('Lowercase relation label, or "none" when unrelated'),
  confidence: z.number().min(0).max(1),
});

const RELATION_SYSTEM = `You decide whether two knowledge-graph items are related and,
if so, name the single most accurate lowercase relation (e.g. works_on, part_of,
related_to). If they are not meaningfully related, set related=false.`;

function labelOf(n: { key: string | null; value: string | null; name: string }) {
  return n.key ? `${n.key}: ${n.value ?? ''}` : n.name;
}

/**
 * For a capped batch of nodes, find nearest semantic neighbours that are not yet
 * linked and ask the LLM to label the relation. Inserts inference edges above the
 * confidence threshold.
 */
export async function inferEdges(
  opts: { batch?: number; neighbors?: number } = {},
): Promise<{ added: number }> {
  const batch = opts.batch ?? 25;
  const neighbors = opts.neighbors ?? 3;

  const seeds = await db
    .select({
      id: graphNodes.id,
      key: graphNodes.key,
      value: graphNodes.value,
      name: graphNodes.name,
      vector: graphNodes.vector,
    })
    .from(graphNodes)
    .where(and(eq(graphNodes.status, 'active'), sql`vector IS NOT NULL`))
    .orderBy(sql`${graphNodes.updatedAt} desc`)
    .limit(batch);

  let added = 0;
  for (const seed of seeds) {
    const distance = sql<number>`vector <=> ${vec(seed.vector as number[])}`;
    const candidates = await db
      .select({
        id: graphNodes.id,
        key: graphNodes.key,
        value: graphNodes.value,
        name: graphNodes.name,
        distance: distance.as('distance'),
      })
      .from(graphNodes)
      .where(
        and(eq(graphNodes.status, 'active'), ne(graphNodes.id, seed.id), sql`vector IS NOT NULL`),
      )
      .orderBy(distance)
      .limit(neighbors);

    for (const cand of candidates) {
      const similarity = 1 - Number(cand.distance);
      if (similarity < 0.55) continue;
      if (await edgeExists(seed.id, cand.id)) continue;

      try {
        const verifier = model.withStructuredOutput(relationSchema, { name: 'relation' });
        const verdict = await verifier.invoke([
          new SystemMessage(RELATION_SYSTEM),
          new HumanMessage(`A: ${labelOf(seed)}\nB: ${labelOf(cand)}`),
        ]);
        if (!verdict.related || verdict.confidence < MIN_EDGE_CONFIDENCE) continue;
        await upsertEdge(seed.id, cand.id, verdict.relation, {
          createdBy: 'inference',
          confidence: verdict.confidence,
        });
        added += 1;
      } catch (error) {
        logger.error('[learn] inferEdges verifier failed', error);
      }
    }
  }
  logger.info(`[learn] inferred ${added} edges`);
  return { added };
}

// ---------------------------------------------------------------------------
// shared edge helpers
// ---------------------------------------------------------------------------

async function edgeExists(a: number, b: number): Promise<boolean> {
  const [row] = await db
    .select({ id: graphEdges.id })
    .from(graphEdges)
    .where(
      or(
        and(eq(graphEdges.fromNodeId, a), eq(graphEdges.toNodeId, b)),
        and(eq(graphEdges.fromNodeId, b), eq(graphEdges.toNodeId, a)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function upsertEdge(
  fromNodeId: number,
  toNodeId: number,
  relation: string,
  opts: { createdBy?: string; confidence?: number; evidence?: string } = {},
) {
  await db
    .insert(graphEdges)
    .values({
      fromNodeId,
      toNodeId,
      relation: relation.trim().toLowerCase(),
      createdBy: opts.createdBy ?? 'agent',
      confidence: opts.confidence ?? 1,
      evidence: opts.evidence,
    })
    .onConflictDoNothing();
}

export { upsertEdge };
