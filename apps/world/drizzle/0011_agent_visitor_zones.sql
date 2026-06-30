-- Per-entity zone tracking (Phase C.5, space addressing): a semantic zone
-- WITHIN an agent's/visitor's current location, so "where exactly are they
-- standing" is knowable without raw pixels. Null = no specific spot known.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "zone" text;--> statement-breakpoint
ALTER TABLE "visitors" ADD COLUMN IF NOT EXISTS "zone" text;
