ALTER TABLE "memories" DROP CONSTRAINT "memories_key_unique";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "data" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "key";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "value";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "created_at";