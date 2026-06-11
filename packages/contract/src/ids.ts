import { z } from "zod";

// The five agent facets and the six locations. Single source of truth — both
// apps/web and apps/world import these; the world server also reuses them as
// tool-parameter schemas where shapes overlap.

export const agentIds = ["career", "researcher", "builder", "writer", "hobby"] as const;
export const AgentId = z.enum(agentIds);
export type AgentId = z.infer<typeof AgentId>;

export const locationIds = ["town", "office", "library", "workshop", "cafe", "park"] as const;
export const LocationId = z.enum(locationIds);
export type LocationId = z.infer<typeof LocationId>;

// Day phase carried on world.time events and used for the day/night tint.
export const dayPhases = ["dawn", "morning", "afternoon", "evening", "night"] as const;
export const DayPhase = z.enum(dayPhases);
export type DayPhase = z.infer<typeof DayPhase>;

// Event visibility scope, persisted on every world_events row.
//  - public:   anyone (visitors included) may see it
//  - location: only agents/visitors co-located when it happened
//  - private:  the agent's own interior monologue / DM-level facts
export const visibilities = ["public", "location", "private"] as const;
export const Visibility = z.enum(visibilities);
export type Visibility = z.infer<typeof Visibility>;
