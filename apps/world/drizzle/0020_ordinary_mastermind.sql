WITH ranked_open_sessions AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "agent_id"
		ORDER BY "started_at" DESC, "id" DESC
	) AS open_rank
	FROM "chat_sessions"
	WHERE "ended_at" IS NULL
)
UPDATE "chat_sessions"
SET "ended_at" = now()
WHERE "id" IN (
	SELECT "id" FROM ranked_open_sessions WHERE open_rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_one_open_per_agent_idx" ON "chat_sessions" USING btree ("agent_id") WHERE "chat_sessions"."ended_at" is null;
