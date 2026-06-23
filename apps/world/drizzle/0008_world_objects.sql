-- MUD embodiment foundation: the canonical, agent-legible, agent-mutable object
-- graph (world_objects), named semantic zones + a coarse kind on locations, and
-- an artifact→object link. All ADDITIVE — no drops, no DB wipe, no destructive
-- ALTER. world_objects is SHADOW-BUILT this slice: seeded alongside the still-live
-- locations.fixtures column, not yet read by perception/use_fixture (cutover is a
-- later slice). IF NOT EXISTS / nullable+defaulted columns keep this idempotent
-- against any base snapshot.

-- world_objects: first-class furniture instances addressed by semantic zone.
CREATE TABLE IF NOT EXISTS "world_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"template" text,
	"display_name" text NOT NULL,
	"location_id" text NOT NULL,
	"zone" text NOT NULL,
	"placement" jsonb,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"affordances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text,
	"attached_artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_agent_id" text,
	"description" text,
	"movable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "world_objects_location_idx" ON "world_objects" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "world_objects_owner_idx" ON "world_objects" USING btree ("owner_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "world_objects_location_zone_idx" ON "world_objects" USING btree ("location_id","zone");--> statement-breakpoint

-- locations: the named-zone registry + a coarse location kind.
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "zones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint

-- artifacts: a link to the world_object this artifact is attached to.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "object_id" text;
