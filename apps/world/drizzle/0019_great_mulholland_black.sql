CREATE TABLE "agent_action_journal" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"tool_call_id" text,
	"agent_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input_hash" text NOT NULL,
	"effect" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"error" text,
	"related_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_action_turn_tool_input_idx" ON "agent_action_journal" USING btree ("turn_id","tool_name","input_hash");--> statement-breakpoint
CREATE INDEX "agent_action_agent_started_idx" ON "agent_action_journal" USING btree ("agent_id","started_at");