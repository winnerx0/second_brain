import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  date,
  varchar,
  vector,
  jsonb,
} from "drizzle-orm/pg-core";

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at").notNull().defaultNow(),
  briefingText: text("briefing_text").notNull(),
  sourcesFetched: text("sources_fetched").array().notNull(),
  success: boolean("success").notNull(),
});

export const taskHistory = pgTable("task_history", {
  id: serial("id").primaryKey(),
  taskName: text("task_name").notNull(),
  source: text("source").notNull(),
  firstSeen: date("first_seen").notNull(),
  timesDeferred: integer("times_deferred").notNull().default(0),
  completedAt: date("completed_at"),
});

export const memories = pgTable("memories", {
  id: serial("id").primaryKey(),
  content: varchar("content", { length: 255 }).notNull(),
  metadata: jsonb("metadata").notNull().default("{}"),
  vector: vector("vector", { dimensions: 1536 }).notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const chatHistory = pgTable("chat_history", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
