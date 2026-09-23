CREATE TABLE "chat_session_participants" (
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "chat_session_participants_session_id_agent_id_pk" PRIMARY KEY("session_id","agent_id")
);
--> statement-breakpoint
-- The retired 1:1 model allowed one visitor to leave multiple sessions open as
-- long as each targeted a different facet. Keep only that visitor's newest
-- session open before installing the room-level uniqueness constraint.
WITH "ranked_open_sessions" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "visitor_id"
		ORDER BY "started_at" DESC, "id" DESC
	) AS "open_rank"
	FROM "chat_sessions"
	WHERE "ended_at" IS NULL
)
UPDATE "chat_sessions"
SET "ended_at" = now()
FROM "ranked_open_sessions"
WHERE "chat_sessions"."id" = "ranked_open_sessions"."id"
	AND "ranked_open_sessions"."open_rank" > 1;
--> statement-breakpoint
-- Every historical 1:1 session begins with its original facet as a member.
-- Closed sessions get a closed membership; open sessions become active rooms.
INSERT INTO "chat_session_participants" ("session_id", "agent_id", "joined_at", "left_at")
SELECT "id", "agent_id", "started_at", "ended_at"
FROM "chat_sessions";
--> statement-breakpoint
-- Directly closing duplicate legacy sessions bypasses the runtime teardown
-- hooks. Repair any facet whose old presence label would otherwise survive the
-- migration, while preserving facets that still belong to the retained room.
UPDATE "agents"
SET "status" = 'awake', "activity" = 'wrapping up a visitor conversation'
WHERE "status" = 'with a visitor'
	AND NOT EXISTS (
		SELECT 1
		FROM "chat_session_participants"
		JOIN "chat_sessions"
			ON "chat_sessions"."id" = "chat_session_participants"."session_id"
		WHERE "chat_session_participants"."agent_id" = "agents"."id"
			AND "chat_session_participants"."left_at" IS NULL
			AND "chat_sessions"."ended_at" IS NULL
	);
--> statement-breakpoint
DROP INDEX "chat_sessions_one_open_per_agent_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_session_participants_one_active_session_per_agent_idx" ON "chat_session_participants" USING btree ("agent_id") WHERE "chat_session_participants"."left_at" is null;--> statement-breakpoint
CREATE INDEX "chat_session_participants_session_idx" ON "chat_session_participants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_one_open_per_visitor_idx" ON "chat_sessions" USING btree ("visitor_id") WHERE "chat_sessions"."ended_at" is null;
