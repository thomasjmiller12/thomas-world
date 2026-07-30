-- 0014: agent failure bookkeeping (liveness + thread auto-recovery).
--
-- Motivation (2026-07-30 incident): Researcher Thomas made ZERO LLM calls for 27
-- days. Its persisted thread contained an assistant message with two consecutive
-- `thinking` blocks, which the API refuses to replay — so every turn 400'd
-- deterministically, forever. Nothing surfaced it: `last_tick_at` was stamped in
-- the failure path too, so /debug showed the agent ticking normally, and /health
-- reported {ok:true, llm:true} throughout.
--
-- These columns make a failing agent observable and let the loop self-heal by
-- reseeding a poisoned thread after N consecutive failures.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_error_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
