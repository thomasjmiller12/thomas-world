-- M2 A2: agents.busy boolean → engagement jsonb (design doc §3.2).
-- The old `busy` flag couldn't carry who an agent was engaged WITH, so a
-- 2-agent chat/scene could strand the second agent. `engagement` stores
-- {kind, id, participants} or NULL; the derived `busy` boolean is engagement
-- IS NOT NULL. Dropping `busy` clears any stale value — boot sweep + chat/scene
-- teardown are the only writers of engagement, and a fresh migration starts
-- everyone unengaged (same restart-safe stance the old clearStaleBusy had).
ALTER TABLE "agents" ADD COLUMN "engagement" jsonb;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "busy";--> statement-breakpoint
-- Per-session / per-visitor bearer tokens (design doc §5 Auth). Nullable so the
-- migration applies to existing rows; new rows always set them at creation.
ALTER TABLE "chat_sessions" ADD COLUMN "session_token" text;--> statement-breakpoint
ALTER TABLE "visitors" ADD COLUMN "visitor_token" text;
