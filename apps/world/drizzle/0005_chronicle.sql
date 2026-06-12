-- M2.1: the Town Chronicle hub (replaces the feed side panel). thread_summaries
-- caches the lazy one-line Haiku summary for each CLOSED room-talk thread so the
-- hub never re-summarizes a settled thread. `thread_id` is the chronicle's
-- deterministic thread id (thr-<location>-<firstEventId> for emergent agent.spoke
-- runs, conv-<conversationId> for historical paced-scene turns). `participants`
-- mirrors the thread's agent roster for cheap display. Open threads are NEVER
-- inserted (they can still grow) — only threads whose last line is older than the
-- grouping gap get a row.
CREATE TABLE "thread_summaries" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"location_id" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- The chronicle does ONE ts-range select per day over world_events; index `ts`
-- so the day window is a range scan rather than a full table scan as the log
-- grows. IF NOT EXISTS — keeps the migration idempotent if a future base
-- snapshot adds it.
CREATE INDEX IF NOT EXISTS "world_events_ts_idx" ON "world_events" USING btree ("ts");
