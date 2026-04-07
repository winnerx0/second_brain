ALTER TABLE "memories" RENAME COLUMN "data" TO "content";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "metadata" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "vector" vector(1536) NOT NULL;