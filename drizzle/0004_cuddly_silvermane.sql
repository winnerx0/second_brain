ALTER TABLE "connections" ADD COLUMN "oauth_connected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "token_expiry" timestamp;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "client_secret" text;