ALTER TABLE "connections"
  ADD COLUMN "oauth_connected" boolean NOT NULL DEFAULT false,
  ADD COLUMN "access_token" text,
  ADD COLUMN "refresh_token" text,
  ADD COLUMN "token_expiry" timestamp;
