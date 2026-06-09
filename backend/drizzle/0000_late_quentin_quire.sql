CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."memory_classification" AS ENUM('identity', 'relationships', 'behavior', 'preferences', 'corrections', 'knowledge', 'unclassified');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."memory_tier" AS ENUM('short_term', 'long_term', 'lifelong');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"briefing_text" text NOT NULL,
	"sources_fetched" text[] NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New Chat' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"oauth_connected" boolean DEFAULT false NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expiry" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "graph_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"relation" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"evidence" text,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "graph_edges_unique" UNIQUE("from_node_id","to_node_id","relation")
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"classification" "memory_classification" DEFAULT 'unclassified' NOT NULL,
	"tier" "memory_tier" DEFAULT 'short_term' NOT NULL,
	"importance" real DEFAULT 0.2 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"promoted_at" timestamp,
	"debate_history" jsonb DEFAULT '[]' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"vector" vector(1536) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_cleanup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_rows" integer DEFAULT 0 NOT NULL,
	"merged_rows" integer DEFAULT 0 NOT NULL,
	"deleted_rows" integer DEFAULT 0 NOT NULL,
	"promoted_rows" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_name" text NOT NULL,
	"source" text NOT NULL,
	"first_seen" date NOT NULL,
	"times_deferred" integer DEFAULT 0 NOT NULL,
	"completed_at" date
);
