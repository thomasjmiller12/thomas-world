DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_threads" WHERE "provider" IS NULL) THEN
    RAISE EXCEPTION 'agent_threads contains null providers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_threads"
    GROUP BY "agent_id", "provider"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent_threads contains duplicate provider keys';
  END IF;

  IF EXISTS (SELECT 1 FROM "llm_usage_daily" WHERE "provider" IS NULL) THEN
    RAISE EXCEPTION 'llm_usage_daily contains null providers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "llm_usage_daily"
    GROUP BY "day", "agent_id", "provider", "model"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'llm_usage_daily contains duplicate provider keys';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent_threads" DROP CONSTRAINT "agent_threads_pkey";--> statement-breakpoint
ALTER TABLE "llm_usage_daily" DROP CONSTRAINT "llm_usage_daily_day_agent_id_model_pk";--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_agent_id_provider_pk" PRIMARY KEY USING INDEX "agent_threads_agent_provider_uidx";--> statement-breakpoint
ALTER TABLE "llm_usage_daily" ADD CONSTRAINT "llm_usage_daily_day_agent_id_provider_model_pk" PRIMARY KEY USING INDEX "llm_usage_daily_day_agent_provider_model_uidx";
