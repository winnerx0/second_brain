CREATE TABLE "linkedin_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"visibility" text DEFAULT 'PUBLIC' NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
