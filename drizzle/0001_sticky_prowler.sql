CREATE TABLE "memory_cleanup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ran_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_rows" integer DEFAULT 0 NOT NULL,
	"merged_rows" integer DEFAULT 0 NOT NULL,
	"deleted_rows" integer DEFAULT 0 NOT NULL,
	"promoted_rows" integer DEFAULT 0 NOT NULL
);
