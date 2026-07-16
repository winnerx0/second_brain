ALTER TABLE "graph_nodes" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD COLUMN "confidence" real DEFAULT 1 NOT NULL;