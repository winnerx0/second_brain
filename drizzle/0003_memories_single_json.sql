ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "memories_key_unique";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "key";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "value";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "created_at";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "data" jsonb NOT NULL DEFAULT '{}';--> statement-breakpoint
TRUNCATE TABLE "memories";--> statement-breakpoint
INSERT INTO "memories" (data, updated_at) VALUES ('{}', now());
