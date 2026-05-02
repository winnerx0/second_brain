import { tool } from 'langchain';
import { z } from 'zod';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { graphEdges, graphNodes } from '../db/schema.js';
import { logger } from '../logger.js';

type NodeKind =
  | 'person'
  | 'project'
  | 'document'
  | 'task'
  | 'decision'
  | 'topic'
  | 'other';

const NODE_KIND_VALUES = [
  'person',
  'project',
  'document',
  'task',
  'decision',
  'topic',
  'other',
] as const;

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function ensureNode(params: {
  name: string;
  kind: NodeKind;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}) {
  const normalizedName = normalizeName(params.name);
  const [existing] = await db
    .select()
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.kind, params.kind),
        eq(graphNodes.normalizedName, normalizedName),
      ),
    )
    .limit(1);

  if (existing) {
    const mergedAliases = Array.from(
      new Set(
        [...(existing.aliases ?? []), ...(params.aliases ?? [])]
          .map((a) => a.trim())
          .filter(Boolean),
      ),
    );
    const mergedMetadata = {
      ...(existing.metadata as Record<string, unknown>),
      ...(params.metadata ?? {}),
    };

    const [updated] = await db
      .update(graphNodes)
      .set({
        name: params.name,
        aliases: mergedAliases,
        metadata: mergedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(graphNodes.id, existing.id))
      .returning();

    return updated!;
  }

  const [created] = await db
    .insert(graphNodes)
    .values({
      kind: params.kind,
      name: params.name,
      normalizedName,
      aliases: (params.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      metadata: params.metadata ?? {},
    })
    .returning();

  return created!;
}

async function resolveNodeId(
  name: string,
  kind?: NodeKind,
): Promise<number | null> {
  const normalized = normalizeName(name);

  const whereClause = kind
    ? and(
        eq(graphNodes.kind, kind),
        or(
          eq(graphNodes.normalizedName, normalized),
          sql`${normalized} = ANY(${graphNodes.aliases})`,
        ),
      )
    : or(
        eq(graphNodes.normalizedName, normalized),
        sql`${normalized} = ANY(${graphNodes.aliases})`,
      );

  const [node] = await db.select().from(graphNodes).where(whereClause).limit(1);
  return node?.id ?? null;
}

export const upsertGraphNode = tool(
  async ({ name, kind, aliases, metadataJson }) => {
    try {
      let metadata: Record<string, unknown> | undefined;
      if (metadataJson) {
        try {
          metadata = JSON.parse(metadataJson) as Record<string, unknown>;
        } catch {
          return 'Invalid metadataJson. Provide a valid JSON object string.';
        }
      }

      const node = await ensureNode({
        name,
        kind,
        aliases,
        metadata,
      });
      return JSON.stringify({
        id: node.id,
        name: node.name,
        kind: node.kind,
        aliases: node.aliases,
      });
    } catch (error) {
      logger.error('[knowledge-graph] upsertGraphNode', error);
      return `Error upserting graph node: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'upsert_graph_node',
    description:
      'Create or update a knowledge-graph node (person, project, document, task, decision, topic).',
    schema: z.object({
      name: z.string().describe('Display name for the node'),
      kind: z.enum(NODE_KIND_VALUES).describe('Entity kind for the node'),
      aliases: z
        .array(z.string())
        .optional()
        .describe('Alternative spellings/names for lookup'),
      metadataJson: z
        .string()
        .optional()
        .describe('JSON object string for additional metadata'),
    }),
  },
);

export const addGraphFact = tool(
  async ({
    subject,
    subjectKind,
    relation,
    object,
    objectKind,
    evidence,
    source,
    subjectAliases,
    objectAliases,
  }) => {
    try {
      const subjectNode = await ensureNode({
        name: subject,
        kind: subjectKind,
        aliases: subjectAliases,
      });
      const objectNode = await ensureNode({
        name: object,
        kind: objectKind,
        aliases: objectAliases,
      });

      const [edge] = await db
        .insert(graphEdges)
        .values({
          fromNodeId: subjectNode.id,
          toNodeId: objectNode.id,
          relation: relation.trim().toLowerCase(),
          evidence,
          source,
        })
        .onConflictDoNothing()
        .returning();

      const resolvedEdge = edge ?? (await db
        .select()
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.fromNodeId, subjectNode.id),
            eq(graphEdges.toNodeId, objectNode.id),
            eq(graphEdges.relation, relation.trim().toLowerCase()),
          ),
        )
        .limit(1)
        .then((r) => r[0]));

      return JSON.stringify({
        edgeId: resolvedEdge!.id,
        subject: {
          id: subjectNode.id,
          name: subjectNode.name,
          kind: subjectNode.kind,
        },
        relation: resolvedEdge!.relation,
        object: {
          id: objectNode.id,
          name: objectNode.name,
          kind: objectNode.kind,
        },
      });
    } catch (error) {
      logger.error('[knowledge-graph] addGraphFact', error);
      return `Error adding graph fact: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'add_graph_fact',
    description:
      'Create a relation edge between two nodes, creating nodes if needed.',
    schema: z.object({
      subject: z.string().describe('Subject entity name'),
      subjectKind: z.enum(NODE_KIND_VALUES).describe('Subject entity kind'),
      relation: z
        .string()
        .describe('Relation label, e.g. depends_on, decided_in, mentions'),
      object: z.string().describe('Object entity name'),
      objectKind: z.enum(NODE_KIND_VALUES).describe('Object entity kind'),
      evidence: z
        .string()
        .optional()
        .describe('Optional source quote or evidence snippet'),
      source: z
        .string()
        .optional()
        .describe('Optional source identifier (page URL, doc ID, etc.)'),
      subjectAliases: z
        .array(z.string())
        .optional()
        .describe('Optional aliases for subject'),
      objectAliases: z
        .array(z.string())
        .optional()
        .describe('Optional aliases for object'),
    }),
  },
);

export const searchGraphNodes = tool(
  async ({ query, kind, limit }) => {
    try {
      const rows = await db
        .select()
        .from(graphNodes)
        .where(
          kind
            ? and(
                eq(graphNodes.kind, kind),
                ilike(graphNodes.name, `%${query}%`),
              )
            : ilike(graphNodes.name, `%${query}%`),
        )
        .limit(limit ?? 10);

      return JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          aliases: r.aliases,
        })),
      );
    } catch (error) {
      logger.error('[knowledge-graph] searchGraphNodes', error);
      return `Error searching graph nodes: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'search_graph_nodes',
    description: 'Search graph nodes by name and optional kind.',
    schema: z.object({
      query: z.string().describe('Text query for matching node names'),
      kind: z
        .enum(NODE_KIND_VALUES)
        .optional()
        .describe('Optional entity kind filter'),
      limit: z
        .number()
        .optional()
        .describe('Maximum results to return (default 10)'),
    }),
  },
);

export const getRelatedGraphContext = tool(
  async ({ name, kind, depth, limit }) => {
    try {
      const rootId = await resolveNodeId(name, kind);
      if (!rootId) {
        return JSON.stringify({
          root: null,
          nodes: [],
          edges: [],
        });
      }

      const maxDepth = Math.max(1, Math.min(depth ?? 2, 3));
      const maxEdges = Math.max(10, Math.min(limit ?? 100, 300));

      const visitedNodes = new Set<number>([rootId]);
      const visitedEdges = new Set<number>();
      let frontier = [rootId];

      for (let level = 0; level < maxDepth; level += 1) {
        if (frontier.length === 0) break;

        const edges = await db
          .select()
          .from(graphEdges)
          .where(
            or(
              inArray(graphEdges.fromNodeId, frontier),
              inArray(graphEdges.toNodeId, frontier),
            ),
          )
          .limit(maxEdges);

        const nextFrontier = new Set<number>();

        for (const edge of edges) {
          visitedEdges.add(edge.id);
          if (!visitedNodes.has(edge.fromNodeId)) {
            visitedNodes.add(edge.fromNodeId);
            nextFrontier.add(edge.fromNodeId);
          }
          if (!visitedNodes.has(edge.toNodeId)) {
            visitedNodes.add(edge.toNodeId);
            nextFrontier.add(edge.toNodeId);
          }
        }

        frontier = Array.from(nextFrontier);
      }

      const ids = Array.from(visitedNodes);
      const nodes = ids.length
        ? await db.select().from(graphNodes).where(inArray(graphNodes.id, ids))
        : [];

      const edges = visitedEdges.size
        ? await db
            .select()
            .from(graphEdges)
            .where(inArray(graphEdges.id, Array.from(visitedEdges)))
        : [];

      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const root = nodeById.get(rootId) ?? null;

      return JSON.stringify({
        root,
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          aliases: n.aliases,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          fromNodeId: e.fromNodeId,
          fromName: nodeById.get(e.fromNodeId)?.name ?? 'Unknown',
          toNodeId: e.toNodeId,
          toName: nodeById.get(e.toNodeId)?.name ?? 'Unknown',
          relation: e.relation,
          evidence: e.evidence,
          source: e.source,
        })),
      });
    } catch (error) {
      logger.error('[knowledge-graph] getRelatedGraphContext', error);
      return `Error fetching related graph context: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: 'get_related_graph_context',
    description: 'Return nearby graph nodes and edges around an entity.',
    schema: z.object({
      name: z.string().describe('Entity name to center the query'),
      kind: z
        .enum(NODE_KIND_VALUES)
        .optional()
        .describe('Optional kind to disambiguate'),
      depth: z
        .number()
        .optional()
        .describe('Traversal depth from 1 to 3 (default 2)'),
      limit: z
        .number()
        .optional()
        .describe('Maximum edges to inspect (default 100)'),
    }),
  },
);

export const knowledgeGraphTools = [
  upsertGraphNode,
  addGraphFact,
  searchGraphNodes,
  getRelatedGraphContext,
];
