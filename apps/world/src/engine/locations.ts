// Location graph, co-presence, and capability gating (plan §3.3).
//
// Gates exist to create movement/co-presence/story — they cover ONLY
// outward-facing public actions, never cognition (memory/reading/thinking).

import { eq } from "drizzle-orm";
import type { AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";

const { locations, agents } = schema;

// The gated capabilities and where each is allowed (plan §3.3 table).
//  - post_bulletin   → town  (notice board)
//  - email_thomas    → office (the outbox)
//  - request_capability → office (the outbox)
//  - publish_blog_post → cafe (the press)
export const LOCATION_GATES: Record<string, LocationId> = {
  post_bulletin: "town",
  email_thomas: "office",
  request_capability: "office",
  publish_blog_post: "cafe",
};

// In-fiction refusal copy for a gated capability used from the wrong place.
const GATE_FICTION: Record<string, string> = {
  post_bulletin:
    "The notice board is in the town square — head to town to post a bulletin.",
  email_thomas:
    "You'll need to be at the office outbox to send mail — it's the only desk with a line to the outside world.",
  request_capability:
    "Capability requests go out from the office outbox — walk over there first.",
  publish_blog_post:
    "Publishing happens at the cafe press — that's where work goes public.",
};

export interface GateResult {
  allowed: boolean;
  // Present only when blocked: the in-fiction error to surface to the agent.
  reason?: string;
  requiredLocation?: LocationId;
}

// Check whether `capability` may be used from `currentLocation`. Ungated
// capabilities (everything not in LOCATION_GATES) always pass.
export function checkGate(
  capability: string,
  currentLocation: LocationId,
): GateResult {
  const required = LOCATION_GATES[capability];
  if (!required) return { allowed: true };
  if (required === currentLocation) return { allowed: true };
  return {
    allowed: false,
    requiredLocation: required,
    reason:
      GATE_FICTION[capability] ??
      `You need to be at ${required} to do that.`,
  };
}

export type LocationRow = typeof locations.$inferSelect;

export async function getLocation(id: LocationId): Promise<LocationRow | undefined> {
  const [row] = await db.select().from(locations).where(eq(locations.id, id));
  return row;
}

export async function allLocations(): Promise<LocationRow[]> {
  return db.select().from(locations);
}

// Adjacency check used by move_to in the tools phase.
export async function isAdjacent(from: LocationId, to: LocationId): Promise<boolean> {
  if (from === to) return true;
  const loc = await getLocation(from);
  if (!loc) return false;
  const adj = (loc.adjacency as LocationId[]) ?? [];
  return adj.includes(to);
}

// Co-presence: who else is at `locationId` (excludes `exclude` if given).
export async function agentsAtLocation(
  locationId: LocationId,
  exclude?: AgentId,
): Promise<(typeof agents.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.locationId, locationId));
  return exclude ? rows.filter((r) => r.id !== exclude) : rows;
}
