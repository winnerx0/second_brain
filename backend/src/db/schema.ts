import {
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  date,
  vector,
  jsonb,
  real,
  unique,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const memoryClassificationEnum = pgEnum('memory_classification', [
  'identity',
  'relationships',
  'behavior',
  'preferences',
  'corrections',
  'knowledge',
  'unclassified',
]);

export const memoryTierEnum = pgEnum('memory_tier', [
  'short_term',
  'long_term',
  'lifelong',
]);

export const agentRuns = pgTable('agent_runs', {
  id: serial('id').primaryKey(),
  ranAt: timestamp('ran_at').notNull().defaultNow(),
  briefingText: text('briefing_text').notNull(),
  sourcesFetched: text('sources_fetched').array().notNull(),
  success: boolean('success').notNull(),
});

export const taskHistory = pgTable('task_history', {
  id: serial('id').primaryKey(),
  taskName: text('task_name').notNull(),
  source: text('source').notNull(),
  firstSeen: date('first_seen').notNull(),
  timesDeferred: integer('times_deferred').notNull().default(0),
  completedAt: date('completed_at'),
});

export const memories = pgTable('memories', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  classification: memoryClassificationEnum('classification')
    .notNull()
    .default('unclassified'),
  tier: memoryTierEnum('tier').notNull().default('short_term'),
  importance: real('importance').notNull().default(0.2),
  vector: vector('vector', { dimensions: 1536 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const chatSessions = pgTable('chat_sessions', {
  id: serial('id').primaryKey(),
  title: text('title').notNull().default('New Chat'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const chatHistory = pgTable('chat_history', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id'),
  role: text('role').notNull(), // "user" | "assistant"
  content: text('content').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const graphNodes = pgTable('graph_nodes', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  metadata: jsonb('metadata').notNull().default('{}'),
  // Memory-node attributes (populated when kind = 'memory'; null for entity nodes)
  key: text('key').unique(),
  value: text('value'),
  classification: memoryClassificationEnum('classification'),
  tier: memoryTierEnum('tier'),
  importance: real('importance').notNull().default(0.2),
  vector: vector('vector', { dimensions: 1536 }),
  // Learning / healing bookkeeping
  recallCount: integer('recall_count').notNull().default(0),
  lastRecalledAt: timestamp('last_recalled_at'),
  status: text('status').notNull().default('active'), // active | superseded | archived
  // Provenance: where this node came from (e.g. 'chat:session:12', 'agent', 'manual',
  // 'cron') and how confident we are in it (0-1).
  source: text('source'),
  confidence: real('confidence').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const graphEdges = pgTable(
  'graph_edges',
  {
    id: serial('id').primaryKey(),
    fromNodeId: integer('from_node_id').notNull(),
    toNodeId: integer('to_node_id').notNull(),
    relation: text('relation').notNull(),
    weight: integer('weight').notNull().default(1),
    confidence: real('confidence').notNull().default(1),
    createdBy: text('created_by').notNull().default('user'), // user | agent | inference
    evidence: text('evidence'),
    source: text('source'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('graph_edges_unique').on(t.fromNodeId, t.toNodeId, t.relation),
  ],
);

export const connections = pgTable('connections', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  oauthConnected: boolean('oauth_connected').notNull().default(false),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiry: timestamp('token_expiry'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const workflows = pgTable(
  'workflows',
  {
    activeRevision: integer('active_revision').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lifecycle: text('lifecycle').notNull().default('manual'),
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    plan: text('plan').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('workflow_due')
      .on(t.nextRunAt)
      .where(sql`${t.enabled} = true`),
  ],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    revisionId: integer('revision_id').references(() => workflowRevisions.id),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    trigger: text('trigger').notNull().default('manual'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    leaseOwner: text('lease_owner'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    feedback: text('feedback'),
    learned: boolean('learned').notNull().default(false),
    id: serial('id').primaryKey(),
    workflowId: integer('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    output: text('output'),
    ranAt: timestamp('ran_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflow_occurrence').on(t.workflowId, t.scheduledFor),
    uniqueIndex('workflow_one_active')
      .on(t.workflowId)
      .where(sql`${t.status} in ('queued','running')`),
  ],
);

export const workflowRevisions = pgTable(
  'workflow_revisions',
  {
    id: serial('id').primaryKey(),
    workflowId: integer('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.workflowId, t.version)],
);
export const workflowSteps = pgTable(
  'workflow_steps',
  {
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    status: text('status').notNull().default('pending'),
    output: text('output'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepId] })],
);
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    event: jsonb('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('workflow_events_run').on(t.runId, t.id)],
);
export const workflowActions = pgTable(
  'workflow_actions',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    tool: text('tool').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    output: jsonb('output'),
  },
  (t) => [unique().on(t.runId, t.stepId, t.fingerprint)],
);
export const workflowLessons = pgTable('workflow_lessons', {
  id: serial('id').primaryKey(),
  workflowId: integer('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  runId: integer('run_id').references(() => workflowRuns.id, {
    onDelete: 'set null',
  }),
  lesson: text('lesson').notNull(),
  confidence: real('confidence').notNull().default(0.5),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const workflowProposals = pgTable('workflow_proposals', {
  id: serial('id').primaryKey(),
  workflowId: integer('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  runId: integer('run_id').references(() => workflowRuns.id, {
    onDelete: 'set null',
  }),
  baseRevision: integer('base_revision').notNull(),
  reason: text('reason').notNull(),
  definition: jsonb('definition').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const workflowWorkers = pgTable('workflow_workers', {
  id: text('id').primaryKey(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
