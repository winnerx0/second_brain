ALTER TABLE "memories" RENAME COLUMN "content" TO "key";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "value" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_key_unique" UNIQUE("key");