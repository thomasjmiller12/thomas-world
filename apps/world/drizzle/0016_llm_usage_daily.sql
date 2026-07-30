-- 0016: llm_usage_daily — the retention rollup (2026-07-30).
--
-- Backing table for engine/retention.ts's daily sweep: before it deletes
-- llm_usage rows older than LLM_USAGE_RETENTION_DAYS (default 30d), it folds
-- them into this day×agent×model summary so historical cost analysis survives
-- past the raw ledger's retention window. `agent_id` is NOT NULL — a raw
-- llm_usage row recorded with a null agentId (Town Crier / Chronicle-summary
-- calls) rolls up under the literal sentinel "_system" (retention.ts
-- SYSTEM_AGENT_KEY) instead, so (day, agent_id, model) can be a real primary
-- key with a working ON CONFLICT upsert.
CREATE TABLE "llm_usage_daily" (
	"day" text NOT NULL,
	"agent_id" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"est_cost_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_daily_day_agent_id_model_pk" PRIMARY KEY("day","agent_id","model")
);
