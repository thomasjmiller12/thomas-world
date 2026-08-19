ALTER TABLE "agent_threads" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "endpoint" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_daily" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_threads_agent_provider_uidx" ON "agent_threads" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_daily_day_agent_provider_model_uidx" ON "llm_usage_daily" USING btree ("day","agent_id","provider","model");