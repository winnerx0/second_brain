import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphNodes, graphEdges } from '../db/schema.js';
import { logger } from '../logger.js';
import { embed } from '../tools/memory.js';

const TOP_K = 5;
const MIN_SIMILARITY = 0.4;

function label(n: { key: string | null; value: string | null; name: string }): string {
  if (n.key) return `${n.key}: ${n.value ?? ''}`.trim();
  return n.name;
}

/**
 * Proactive recall: given the user's message, return a compact context block of the
 * most relevant memories plus their one-hop graph neighbours, ready to prepend to the
 * system prompt. Returns '' when nothing is relevant. Failures degrade to '' so chat
 * never breaks because recall stumbled.
 */
export async function buildRecallContext(text: string): Promise<string> {
  try {
    const trimmed = text.trim();
    if (trimmed.length < 3) return '';

    const queryEmbedding = await embed(trimmed);
    const distance = sql<number>`vector <=> ${JSON.stringify(queryEmbedding)}::vector`;
    const maxDistance = 1 - MIN_SIMILARITY;

    const hits = await db
      .select({
        id: graphNodes.id,
        kind: graphNodes.kind,
        key: graphNodes.key,
        value: graphNodes.value,
        name: graphNodes.name,
        classification: graphNodes.classification,
        distance: distance.as('distance'),
      })
      .from(graphNodes)
      .where(
        and(eq(graphNodes.status, 'active'), sql`vector IS NOT NULL`, sql`${distance} <= ${maxDistance}`),
      )
      .orderBy(distance)
      .limit(TOP_K);

    if (hits.length === 0) return '';

    const hitIds = hits.map((h) => h.id);

    // One-hop neighbours of the hits, so related facts come along for free.
    const edges = await db
      .select()
      .from(graphEdges)
      .where(or(inArray(graphEdges.fromNodeId, hitIds), inArray(graphEdges.toNodeId, hitIds)))
      .limit(40);

    const neighbourIds = new Set<number>();
    for (const e of edges) {
      if (!hitIds.includes(e.fromNodeId)) neighbourIds.add(e.fromNodeId);
      if (!hitIds.includes(e.toNodeId)) neighbourIds.add(e.toNodeId);
    }
    const neighbours = neighbourIds.size
      ? await db
          .select({
            id: graphNodes.id,
            key: graphNodes.key,
            value: graphNodes.value,
            name: graphNodes.name,
          })
          .from(graphNodes)
          .where(and(inArray(graphNodes.id, Array.from(neighbourIds)), ne(graphNodes.status, 'superseded')))
      : [];
    const nameById = new Map<number, string>();
    for (const h of hits) nameById.set(h.id, label(h));
    for (const nb of neighbours) nameById.set(nb.id, label(nb));

    const lines: string[] = [];
    for (const h of hits) {
      const sim = (1 - Number(h.distance)).toFixed(2);
      lines.push(`- ${label(h)}${h.classification ? ` [${h.classification}]` : ''} (≈${sim})`);
      const rels = edges
        .filter((e) => e.fromNodeId === h.id || e.toNodeId === h.id)
        .slice(0, 4)
        .map((e) => {
          const otherId = e.fromNodeId === h.id ? e.toNodeId : e.fromNodeId;
          const arrow = e.fromNodeId === h.id ? '→' : '←';
          const other = nameById.get(otherId);
          return other ? `    ${arrow} ${e.relation} ${other}` : null;
        })
        .filter(Boolean) as string[];
      lines.push(...rels);
    }

    return `Relevant context from memory (auto-recalled — use only if pertinent, do not mention this block):\n${lines.join('\n')}`;
  } catch (error) {
    logger.error('[recall-context] failed', error);
    return '';
  }
}
