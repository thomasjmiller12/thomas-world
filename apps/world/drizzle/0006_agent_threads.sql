-- M3 (continuity): each agent's CONTINUOUS thread — the persisted
-- BetaMessageParam[] that is the agent's consciousness across ticks and chats,
-- including server-side compaction blocks (which round-trip verbatim). One row
-- per agent; loaded into the tool runner to resume and re-persisted after every
-- successful turn. `input_cursor` is the high-water world-event id already
-- folded into the thread as notice-push (the delta cursor). Like
-- agents.location_id, this is living state — the seed must NEVER reset it.
-- IF NOT EXISTS keeps the migration idempotent against any future base snapshot.
CREATE TABLE IF NOT EXISTS "agent_threads" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_cursor" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
