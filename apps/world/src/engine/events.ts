// Event log helpers (plan §3.2). The `world_events` table is append-only:
// `appendEvent` is the ONLY write path and there is no update/delete here.
//
// Perception scoping (plan §3.4): an agent at tick time should see full detail
// for events at its own location, but only a headline for public/global events
// elsewhere, and nothing it couldn't plausibly know.

import { asc, gt, desc, and, sql, inArray, type SQL } from "drizzle-orm";
import type { WorldEvent, WorldEventType, AgentId, LocationId, Visibility } from "@town/contract";
import { db, schema } from "../db/client.js";
import { publish } from "./bus.js";

const { worldEvents } = schema;

// Input to appendEvent: the contract envelope minus the server-assigned id/ts.
export interface AppendEventInput {
  type: WorldEventType;
  agentId?: AgentId | null;
  locationId?: LocationId | null;
  visitorId?: string | null;
  visibility: Visibility;
  // The per-type payload (validated against the contract by callers/helpers).
  payload: Record<string, unknown>;
}

// Map a DB row to the contract WorldEvent shape (id + ts are strings on wire).
function rowToEvent(row: typeof worldEvents.$inferSelect): WorldEvent {
  return {
    id: String(row.id),
    ts: row.ts.toISOString(),
    type: row.type as WorldEventType,
    agentId: (row.agentId ?? null) as AgentId | null,
    locationId: (row.locationId ?? null) as LocationId | null,
    visitorId: row.visitorId ?? null,
    visibility: row.visibility as Visibility,
    payload: row.payload as never,
  } as WorldEvent;
}

// The single append-only write path. Returns the materialized contract event
// (with its assigned id + ts) so callers can fan it out to the SSE bus.
export async function appendEvent(input: AppendEventInput): Promise<WorldEvent> {
  const [row] = await db
    .insert(worldEvents)
    .values({
      type: input.type,
      agentId: input.agentId ?? null,
      locationId: input.locationId ?? null,
      visitorId: input.visitorId ?? null,
      visibility: input.visibility,
      payload: input.payload,
    })
    .returning();
  const event = rowToEvent(row);
  publish(event); // realtime fan-out to connected SSE subscribers
  return event;
}

// Events strictly after a given id (the SSE Last-Event-ID / polling path).
export async function eventsAfter(afterId?: string, limit = 200): Promise<WorldEvent[]> {
  const conds: SQL[] = [];
  if (afterId !== undefined && afterId !== "") {
    const n = Number(afterId);
    if (Number.isFinite(n)) conds.push(gt(worldEvents.id, n));
  }
  const rows = await db
    .select()
    .from(worldEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(worldEvents.id))
    .limit(limit);
  return rows.map(rowToEvent);
}

// Most-recent events (snapshot / debug), newest first then reversed to chrono.
export async function recentEvents(limit = 30): Promise<WorldEvent[]> {
  const rows = await db
    .select()
    .from(worldEvents)
    .orderBy(desc(worldEvents.id))
    .limit(limit);
  return rows.map(rowToEvent).reverse();
}

// Last ~N events involving a specific agent (feeds GET /agents/:id).
export async function recentEventsForAgent(agentId: AgentId, limit = 5): Promise<WorldEvent[]> {
  const rows = await db
    .select()
    .from(worldEvents)
    .where(sql`${worldEvents.agentId} = ${agentId}`)
    .orderBy(desc(worldEvents.id))
    .limit(limit);
  return rows.map(rowToEvent).reverse();
}

// A headline-collapsed view of an event: for events the agent did NOT witness
// at its own location, we strip the rich body so it only learns the gist
// ("someone moved", "a bulletin was posted") — never private detail.
function toHeadline(e: WorldEvent): WorldEvent {
  // Each case rebuilds its own member so the discriminated union stays narrow
  // (a shared spread widens the payload type and breaks the union).
  switch (e.type) {
    case "agent.thought":
      // Public-safe thoughts only carry text — collapse it to a gist marker.
      return { ...e, payload: { ...e.payload, text: "" } };
    case "agent.spoke":
      return { ...e, payload: { ...e.payload, text: "" } };
    case "conversation.turn":
      return { ...e, payload: { ...e.payload, text: "" } };
    default:
      return e;
  }
}

// Perception scoping (plan §3.4). Given the events since the agent's last tick,
// return what THIS agent could plausibly know:
//  - events at the agent's current location → full detail
//  - public events anywhere → headline
//  - location-scoped events elsewhere → dropped
//  - private events not owned by the agent → dropped
export function scopeEventsForAgent(
  events: WorldEvent[],
  agentId: AgentId,
  agentLocation: LocationId,
): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (const e of events) {
    const here = e.locationId === agentLocation;
    if (e.visibility === "private") {
      // Only the owning agent perceives its own private events.
      if (e.agentId === agentId) out.push(e);
      continue;
    }
    if (here) {
      out.push(e); // co-located: full detail
      continue;
    }
    if (e.visibility === "public") {
      out.push(toHeadline(e)); // global/public: gist only
    }
    // location-scoped elsewhere → not perceived
  }
  return out;
}

// Events since a given id, scoped to one agent's perception. Convenience used
// by the observation builder in the runtime phase.
//
// Returns the scoped events PLUS `maxConsideredId` — the highest world_events id
// actually fetched (before scoping). The tick advances the perception cursor to
// THIS id, never the global max: `eventsAfter` is capped at `limit`, so if more
// than `limit` events accumulated between ticks, jumping the cursor to the global
// max would silently skip the un-fetched tail. Advancing only to the last id we
// examined keeps perception gap-free (the next tick picks up where we stopped).
export async function perceivedEventsSince(
  afterId: string,
  agentId: AgentId,
  agentLocation: LocationId,
): Promise<{ events: WorldEvent[]; maxConsideredId: string }> {
  const all = await eventsAfter(afterId);
  const maxConsideredId = all.length ? all[all.length - 1].id : afterId;
  return { events: scopeEventsForAgent(all, agentId, agentLocation), maxConsideredId };
}

// Helper for callers that want events of specific types only.
export async function eventsOfTypes(types: WorldEventType[], limit = 100): Promise<WorldEvent[]> {
  const rows = await db
    .select()
    .from(worldEvents)
    .where(inArray(worldEvents.type, types))
    .orderBy(desc(worldEvents.id))
    .limit(limit);
  return rows.map(rowToEvent).reverse();
}
