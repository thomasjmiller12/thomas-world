// Visitor presence (plan §3.1). Presence is keyed to an SSE connection's
// lifetime: register on connect (visitor.arrived), drop on disconnect
// (visitor.left). Arrivals/departures are world events agents perceive.

import { eq, and, gt, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { visitors, worldEvents } = schema;
export type VisitorRow = typeof visitors.$inferSelect;

// How long after a visitor's last SSE touch we still consider them "present".
// Matches the window the snapshot/observation use elsewhere.
const PRESENCE_WINDOW_MS = 2 * 60_000;

export async function registerVisitor(name: string): Promise<VisitorRow> {
  const id = randomUUID();
  // visitorToken is returned to the registering browser and required to
  // authorize PATCH /visitors/:id and POST /visitors/:id/interact (design §5).
  const visitorToken = randomUUID();
  const [row] = await db.insert(visitors).values({ id, name, visitorToken }).returning();
  return row;
}

// Auth check for visitor-scoped mutations. True iff the visitor exists and the
// supplied token matches the one minted at registration. Rows created before
// this migration (null token) cannot be authorized — treat as 401.
export async function visitorTokenValid(id: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [v] = await db
    .select({ token: visitors.visitorToken })
    .from(visitors)
    .where(eq(visitors.id, id));
  return Boolean(v && v.token && v.token === token);
}

// Emitted when the visitor's SSE stream opens. Public — agents can perceive
// "someone's at the door" without any frontend coupling.
export async function visitorArrived(id: string, name: string) {
  await appendEvent({
    type: "visitor.arrived",
    visitorId: id,
    visibility: "public",
    payload: { visitorId: id, name },
  });
}

export async function visitorLeft(id: string) {
  const [row] = await db.select().from(visitors).where(eq(visitors.id, id));
  const name = row?.name ?? "a visitor";
  await appendEvent({
    type: "visitor.left",
    visitorId: id,
    visibility: "public",
    payload: { visitorId: id, name },
  });
}

export async function touchVisitor(id: string) {
  await db.update(visitors).set({ lastSeenAt: new Date() }).where(eq(visitors.id, id));
}

export async function getVisitor(id: string): Promise<VisitorRow | undefined> {
  const [row] = await db.select().from(visitors).where(eq(visitors.id, id));
  return row;
}

// Report a scene transition (design doc §2). Persists the new location and, when
// it actually changed, emits a public `visitor.moved {from, to}` so agents at
// the destination perceive the arrival. Returns the previous location (null on
// first placement) so the HTTP layer can decide which agents to boost.
export async function moveVisitor(
  id: string,
  to: LocationId,
): Promise<{ from: LocationId | null; changed: boolean } | undefined> {
  const [row] = await db.select().from(visitors).where(eq(visitors.id, id));
  if (!row) return undefined;
  const from = (row.locationId ?? null) as LocationId | null;
  if (from === to) return { from, changed: false };
  await db.update(visitors).set({ locationId: to }).where(eq(visitors.id, id));
  await appendEvent({
    type: "visitor.moved",
    visitorId: id,
    locationId: to,
    visibility: "public",
    payload: { visitorId: id, name: row.name, from, to },
  });
  return { from, changed: true };
}

// Visitors currently AT a location (design doc §2 — the location-aware
// observation upgrade). Present = touched within PRESENCE_WINDOW_MS. Ordered
// most-recently-seen first so the observation can lead with the freshest arrival.
export async function visitorsAtLocation(locationId: LocationId): Promise<VisitorRow[]> {
  const cutoff = new Date(Date.now() - PRESENCE_WINDOW_MS);
  return db
    .select()
    .from(visitors)
    .where(and(eq(visitors.locationId, locationId), gt(visitors.lastSeenAt, cutoff)));
}

// When (epoch ms) each given visitor most recently arrived AT `locationId`,
// read from the latest `visitor.moved {to: locationId}` event. Feeds the
// observation's arrival-recency phrasing ("arrived a few minutes ago"). Returns
// a map visitorId → arrival ms; a visitor with no recorded move is absent.
export async function arrivalTimesAtLocation(
  locationId: LocationId,
  visitorIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (visitorIds.length === 0) return out;
  // One row per visitor: the most recent move INTO this location. We pull the
  // recent moved-here events and keep the first (newest) per visitor.
  const rows = await db
    .select({ visitorId: worldEvents.visitorId, ts: worldEvents.ts })
    .from(worldEvents)
    .where(and(eq(worldEvents.type, "visitor.moved"), eq(worldEvents.locationId, locationId)))
    .orderBy(desc(worldEvents.id))
    .limit(200);
  for (const r of rows) {
    if (r.visitorId && visitorIds.includes(r.visitorId) && !out.has(r.visitorId)) {
      out.set(r.visitorId, r.ts.getTime());
    }
  }
  return out;
}

// Update the visitor's display name (gate-name rename, design doc §2). No event:
// a rename isn't a world happening, and the name flows into the next observation
// packet / events that carry it anyway.
export async function renameVisitor(id: string, name: string): Promise<void> {
  await db.update(visitors).set({ name }).where(eq(visitors.id, id));
}
