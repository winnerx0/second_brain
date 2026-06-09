DROP TABLE IF EXISTS "memory_cleanup_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "memories";
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"classification" "memory_classification" DEFAULT 'unclassified' NOT NULL,
	"tier" "memory_tier" DEFAULT 'short_term' NOT NULL,
	"importance" real DEFAULT 0.2 NOT NULL,
	"vector" vector(1536) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memories_key_unique" UNIQUE("key")
);
