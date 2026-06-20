-- M2.2: the LLM Town Crier issue, the curated public-reference catalog, the
-- portfolio proof cards, and share-card attachments on chat messages. All
-- ADDITIVE (no DB wipe) — a clean compatible cutover. IF NOT EXISTS keeps the
-- migration idempotent against any future base snapshot.

-- chronicle_issues: one world-authored newspaper issue per day.
CREATE TABLE IF NOT EXISTS "chronicle_issues" (
	"day" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"byline" text DEFAULT 'The Town Crier' NOT NULL,
	"body_md" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_thread_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- external_references: the curated public-reference allowlist agents share from.
CREATE TABLE IF NOT EXISTS "external_references" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"short_title" text,
	"summary" text NOT NULL,
	"body_md" text,
	"url" text,
	"github_url" text,
	"live_url" text,
	"image_url" text,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"source_path" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_references_kind_idx" ON "external_references" USING btree ("kind");--> statement-breakpoint

-- portfolio_proofs: claims with evidence links (the About hub's Proof tab).
CREATE TABLE IF NOT EXISTS "portfolio_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"claim" text NOT NULL,
	"summary" text NOT NULL,
	"body_md" text NOT NULL,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- share-card attachments on chat messages (replayed on panel rehydrate).
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;
