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
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" varchar(255) NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"vector" vector(1536) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
