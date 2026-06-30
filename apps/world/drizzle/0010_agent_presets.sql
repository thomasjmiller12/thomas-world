-- Agent-saved beat presets ("customization within bounds", not raw beat
-- authoring) — a NAMED, params-only variant of an existing catalog beat.
CREATE TABLE IF NOT EXISTS "agent_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"beat" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_presets_agent_name_idx" ON "agent_presets" USING btree ("agent_id","name");
