import { z } from 'zod';
import { HumanMessage, SystemMessage } from 'langchain';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphNodes, graphEdges } from '../db/schema.js';
import { logger } from '../logger.js';
import { model } from '../shared.js';
import { runMemoryCleanup } from '../memory-cleanup.js';
import {
  embed,
  determineTier,
  importanceForClassification,
  classifications,
  type Classification,
} from '../tools/memory.js';
import { decayImportance, inferEdges, upsertEdge } from './learn.js';

// Two active nodes of the same kind are merged above this cosine similarity.
const MERGE_SIMILARITY = 0.95;

function vec(embedding: number[]) {
  return sql`${JSON.stringify(embedding)}::vector`;
}

// ---------------------------------------------------------------------------
// Dedupe & merge — collapse near-identical nodes into one canonical node
// ---------------------------------------------------------------------------

interface MergeNode {
  id: number;
  kind: string;
  name: string;
  aliases: string[];
  importance: number;
  recallCount: number;
}

export async function dedupeAndMerge(): Promise<{ merged: number }> {
  const rows = await db
    .select({
      id: graphNodes.id,
      kind: graphNodes.kind,
      name: graphNodes.name,
      aliases: graphNodes.aliases,
      importance: graphNodes.importance,
      recallCount: graphNodes.recallCount,
      vector: graphNodes.vector,
    })
    .from(graphNodes)
    .where(and(eq(graphNodes.status, 'active'), sql`vector IS NOT NULL`));

  const consumed = new Set<number>();
  let merged = 0;

  for (const row of rows) {
    if (consumed.has(row.id)) continue;

    const distance = sql<number>`vector <=> ${vec(row.vector as number[])}`;
    const neighbors = await db
      .select({
        id: graphNodes.id,
        kind: graphNodes.kind,
        name: graphNodes.name,
        aliases: graphNodes.aliases,
        importance: graphNodes.importance,
        recallCount: graphNodes.recallCount,
        distance: distance.as('distance'),
      })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.status, 'active'),
          eq(graphNodes.kind, row.kind),
          ne(graphNodes.id, row.id),
          sql`vector IS NOT NULL`,
        ),
      )
      .orderBy(distance)
      .limit(10);

    const cluster = neighbors.filter(
      (n) => !consumed.has(n.id) && 1 - Number(n.distance) >= MERGE_SIMILARITY,
    );
    if (cluster.length === 0) continue;

    const members: MergeNode[] = [row, ...cluster].map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      aliases: (n.aliases as string[]) ?? [],
      importance: n.importance,
      recallCount: n.recallCount,
    }));

    // Canonical = strongest by importance, then recall, then lowest id (oldest).
    members.sort(
      (a, b) =>
        b.importance - a.importance ||
        b.recallCount - a.recallCount ||
        a.id - b.id,
    );
    const canonical = members[0]!;
    const losers = members.slice(1);

    await mergeInto(canonical, losers);
    for (const m of members) consumed.add(m.id);
    merged += losers.length;
  }

  logger.info(`[heal] merged ${merged} duplicate nodes`);
  return { merged };
}

async function mergeInto(canonical: MergeNode, losers: MergeNode[]) {
  if (losers.length === 0) return;
  const loserIds = losers.map((l) => l.id);

  // Fold aliases/names of losers into the canonical node.
  const aliasSet = new Set(
    [...canonical.aliases, ...losers.flatMap((l) => [l.name, ...l.aliases])]
      .map((a) => a.trim())
      .filter(Boolean),
  );
  await db
    .update(graphNodes)
    .set({ aliases: Array.from(aliasSet), updatedAt: new Date() })
    .where(eq(graphNodes.id, canonical.id));

  // Re-point every edge touching a loser onto the canonical node (skip self-loops
  // and conflicts), then drop the originals.
  const edges = await db
    .select()
    .from(graphEdges)
    .where(or(inArray(graphEdges.fromNodeId, loserIds), inArray(graphEdges.toNodeId, loserIds)));

  for (const e of edges) {
    const from = loserIds.includes(e.fromNodeId) ? canonical.id : e.fromNodeId;
    const to = loserIds.includes(e.toNodeId) ? canonical.id : e.toNodeId;
    if (from !== to) {
      await upsertEdge(from, to, e.relation, {
        createdBy: e.createdBy,
        confidence: e.confidence,
        evidence: e.evidence ?? undefined,
      });
    }
  }
  await db
    .delete(graphEdges)
    .where(or(inArray(graphEdges.fromNodeId, loserIds), inArray(graphEdges.toNodeId, loserIds)));

  // Soft-supersede losers and record provenance.
  await db
    .update(graphNodes)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(inArray(graphNodes.id, loserIds));
  for (const id of loserIds) {
    await upsertEdge(canonical.id, id, 'superseded_by', { createdBy: 'agent' });
  }
}

// ---------------------------------------------------------------------------
// Resolve contradictions — among very similar active memories with different
// values, keep the strongest and supersede the rest.
// ---------------------------------------------------------------------------

const winnerSchema = z.object({
  winnerId: z.number(),
  reason: z.string().max(300),
});

const CONTRADICTION_SYSTEM = `Two stored memories about the user appear to conflict.
Pick the single id whose value should remain true and active. Prefer the more recent,
specific, and corrected fact. Reply with structured output only.`;

export async function resolveContradictions(): Promise<{ resolved: number }> {
  // Candidate conflicts: active memory pairs that are highly similar (same subject)
  // yet store a different value.
  const rows = await db
    .select({
      id: graphNodes.id,
      key: graphNodes.key,
      value: graphNodes.value,
      importance: graphNodes.importance,
      updatedAt: graphNodes.updatedAt,
      vector: graphNodes.vector,
    })
    .from(graphNodes)
    .where(and(eq(graphNodes.kind, 'memory'), eq(graphNodes.status, 'active'), sql`vector IS NOT NULL`));

  const seen = new Set<number>();
  let resolved = 0;

  for (const a of rows) {
    if (seen.has(a.id)) continue;
    const distance = sql<number>`vector <=> ${vec(a.vector as number[])}`;
    const [b] = await db
      .select({
        id: graphNodes.id,
        key: graphNodes.key,
        value: graphNodes.value,
        distance: distance.as('distance'),
      })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.kind, 'memory'),
          eq(graphNodes.status, 'active'),
          ne(graphNodes.id, a.id),
          sql`vector IS NOT NULL`,
        ),
      )
      .orderBy(distance)
      .limit(1);

    if (!b) continue;
    const similarity = 1 - Number(b.distance);
    // Same subject (>=0.85) but a genuinely different value = contradiction.
    if (similarity < 0.85) continue;
    if ((a.value ?? '').trim() === (b.value ?? '').trim()) continue;

    try {
      const judge = model.withStructuredOutput(winnerSchema, { name: 'pick_winner' });
      const verdict = await judge.invoke([
        new SystemMessage(CONTRADICTION_SYSTEM),
        new HumanMessage(
          `Memory ${a.id} — ${a.key}: ${a.value}\nMemory ${b.id} — ${b.key}: ${b.value}`,
        ),
      ]);
      const winnerId = verdict.winnerId === b.id ? b.id : a.id;
      const loserId = winnerId === a.id ? b.id : a.id;

      await db
        .update(graphNodes)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(eq(graphNodes.id, loserId));
      await upsertEdge(winnerId, loserId, 'superseded_by', { createdBy: 'agent' });
      seen.add(a.id);
      seen.add(b.id);
      resolved += 1;
    } catch (error) {
      logger.error('[heal] resolveContradictions judge failed', error);
    }
  }

  logger.info(`[heal] resolved ${resolved} contradictions`);
  return { resolved };
}

// ---------------------------------------------------------------------------
// Repair edges — drop edges with missing/superseded endpoints, dedupe parallels
// ---------------------------------------------------------------------------

export async function repairEdges(): Promise<{ removed: number }> {
  // Orphaned: an endpoint no longer exists or is not active.
  const activeIds = await db
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(ne(graphNodes.status, 'superseded'));
  const valid = new Set(activeIds.map((r) => r.id));

  const edges = await db.select().from(graphEdges);
  const orphanIds = edges
    .filter(
      (e) =>
        e.relation !== 'superseded_by' &&
        (!valid.has(e.fromNodeId) || !valid.has(e.toNodeId)),
    )
    .map((e) => e.id);

  if (orphanIds.length > 0) {
    await db.delete(graphEdges).where(inArray(graphEdges.id, orphanIds));
  }
  logger.info(`[heal] removed ${orphanIds.length} orphaned edges`);
  return { removed: orphanIds.length };
}

// ---------------------------------------------------------------------------
// Backfill — re-embed missing vectors, re-classify unclassified memories
// ---------------------------------------------------------------------------

const classifySchema = z.object({
  classification: z.enum(classifications),
});

const CLASSIFY_SYSTEM = `Classify the stored memory into exactly one category:
identity, relationships, behavior, preferences, corrections, knowledge, or
unclassified. Reply with structured output only.`;

export async function backfill(): Promise<{ embedded: number; reclassified: number }> {
  // 1. Re-embed nodes with a null vector (key for memories, name for entities).
  const missing = await db
    .select({ id: graphNodes.id, key: graphNodes.key, name: graphNodes.name })
    .from(graphNodes)
    .where(and(isNull(graphNodes.vector), ne(graphNodes.status, 'superseded')));

  let embedded = 0;
  for (const n of missing) {
    try {
      const embedding = await embed(n.key ?? n.name);
      await db
        .update(graphNodes)
        .set({ vector: vec(embedding), updatedAt: new Date() })
        .where(eq(graphNodes.id, n.id));
      embedded += 1;
    } catch (error) {
      logger.error('[heal] backfill embed failed', error);
    }
  }

  // 2. Re-classify memories still marked 'unclassified'.
  const unclassified = await db
    .select({ id: graphNodes.id, key: graphNodes.key, value: graphNodes.value })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.kind, 'memory'),
        eq(graphNodes.status, 'active'),
        eq(graphNodes.classification, 'unclassified'),
      ),
    );

  let reclassified = 0;
  for (const m of unclassified) {
    try {
      const classifier = model.withStructuredOutput(classifySchema, { name: 'classify' });
      const out = await classifier.invoke([
        new SystemMessage(CLASSIFY_SYSTEM),
        new HumanMessage(`${m.key}: ${m.value}`),
      ]);
      const cls = out.classification as Classification;
      if (cls === 'unclassified') continue;
      await db
        .update(graphNodes)
        .set({
          classification: cls,
          importance: importanceForClassification(cls),
          tier: determineTier(cls),
          updatedAt: new Date(),
        })
        .where(eq(graphNodes.id, m.id));
      reclassified += 1;
    } catch (error) {
      logger.error('[heal] reclassify failed', error);
    }
  }

  logger.info(`[heal] backfill embedded=${embedded} reclassified=${reclassified}`);
  return { embedded, reclassified };
}

// ---------------------------------------------------------------------------
// Orchestrator — run the full self-heal + self-learn maintenance pass
// ---------------------------------------------------------------------------

export interface MaintenanceSummary {
  resolved: number;
  merged: number;
  pruned: number;
  edgesRemoved: number;
  embedded: number;
  reclassified: number;
  decayed: number;
  edgesAdded: number;
}

export async function runMaintenance(
  opts: { dryRun?: boolean } = {},
): Promise<MaintenanceSummary> {
  const dryRun = opts.dryRun ?? false;

  // Order matters: reconcile/merge first, then prune, then repair dangling edges,
  // then backfill and grow the graph.
  const { resolved } = dryRun ? { resolved: 0 } : await resolveContradictions();
  const { merged } = dryRun ? { merged: 0 } : await dedupeAndMerge();
  // Soft-archive (reversible) instead of hard-deleting during routine maintenance.
  const cleanup = await runMemoryCleanup({ dryRun, softArchive: true });
  const { removed } = dryRun ? { removed: 0 } : await repairEdges();
  const { embedded, reclassified } = dryRun
    ? { embedded: 0, reclassified: 0 }
    : await backfill();
  const { decayed } = dryRun ? { decayed: 0 } : await decayImportance();
  const { added } = dryRun ? { added: 0 } : await inferEdges();

  return {
    resolved,
    merged,
    pruned: cleanup.deleted,
    edgesRemoved: removed,
    embedded,
    reclassified,
    decayed,
    edgesAdded: added,
  };
}
