-- M2 B: embodied visitors + chat liveness (design doc §2, §3.4).
-- visitors gain a logical location (nullable: no body until the frontend reports
-- the first scene via PATCH /visitors/:id; a change emits public `visitor.moved`).
-- chat_sessions gain a `last_ping_at` for the liveness-aware sweep — the 3-min
-- rule (no ping AND no message) replaces the old 10-min last-activity rule.
ALTER TABLE "visitors" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "last_ping_at" timestamp with time zone;
