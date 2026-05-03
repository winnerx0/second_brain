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
} from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const graphEdges = pgTable('graph_edges', {
  id: serial('id').primaryKey(),
  fromNodeId: integer('from_node_id').notNull(),
  toNodeId: integer('to_node_id').notNull(),
  relation: text('relation').notNull(),
  weight: integer('weight').notNull().default(1),
  evidence: text('evidence'),
  source: text('source'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => [unique('graph_edges_unique').on(t.fromNodeId, t.toNodeId, t.relation)]);

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
