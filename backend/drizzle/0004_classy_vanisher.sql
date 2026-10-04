ALTER TABLE "graph_edges" ADD COLUMN "confidence" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD COLUMN "created_by" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "value" text;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "classification" "memory_classification";--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "tier" "memory_tier";--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "importance" real DEFAULT 0.2 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "vector" vector(1536);--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "recall_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "last_recalled_at" timestamp;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_key_unique" UNIQUE("key");--> statement-breakpoint
-- Promote existing flat memories into graph_nodes as kind='memory'.
-- The memories table is kept for one release as a fallback (dropped in a follow-up migration).
INSERT INTO "graph_nodes" (
  "kind", "name", "normalized_name", "key", "value",
  "classification", "tier", "importance", "vector", "status",
  "created_at", "updated_at"
)
SELECT
  'memory',
  "key",
  lower(trim("key")),
  "key",
  "value",
  "classification",
  "tier",
  "importance",
  "vector",
  'active',
  "created_at",
  "updated_at"
FROM "memories"
ON CONFLICT ("key") DO NOTHING;
