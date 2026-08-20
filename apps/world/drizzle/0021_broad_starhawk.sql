ALTER TABLE "agent_action_journal" ADD COLUMN "semantic_event" jsonb;--> statement-breakpoint
ALTER TABLE "agent_action_journal" ADD COLUMN "semantic_event_id" bigint;--> statement-breakpoint
ALTER TABLE "agent_action_journal" ADD COLUMN "semantic_emitted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_action_semantic_pending_idx" ON "agent_action_journal" USING btree ("completed_at") WHERE "agent_action_journal"."semantic_event" IS NOT NULL AND "agent_action_journal"."semantic_event_id" IS NULL;