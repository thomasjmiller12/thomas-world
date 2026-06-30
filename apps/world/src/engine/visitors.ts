// Visitor presence (plan §3.1). Presence is keyed to an SSE connection's
// lifetime: register on connect (visitor.arrived), drop on disconnect
// (visitor.left). Arrivals/departures are world events agents perceive.

import { eq, and, gt, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentId, LocationId } from "@town/contract";
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

// --- presence debounce -------------------------------------------------------
// Proxies recycle long-lived SSE connections (observed: every ~15 min on
// Railway's edge); EventSource reopens seconds later. Tying arrived/left
// 1:1 to the connection lifetime turned every recycle into a feed-visible
// departure+arrival pair. Connections are refcounted per visitor and a
// departure waits out a grace window — a reconnect inside it cancels the
// departure and emits nothing. In-memory by design (single process, same as
// the rate limiters); across a restart the DB presence window covers the gap.
const LEAVE_GRACE_MS = 60_000;

export interface PresenceTracker {
  // Call on SSE connect, with lastSeenAt read BEFORE the connect's touchVisitor.
  // Resolves true when a REAL arrival was emitted (not a transport reconnect) —
  // callers use this to welcome the visitor (tick boosts) without re-welcoming
  // every proxy recycle.
  connected(id: string, name: string, lastSeenAt: Date | null): Promise<boolean>;
  // Call on SSE disconnect. The departure emits only after the grace window
  // passes with no reconnect (and no other live connection for this visitor).
  disconnected(id: string): void;
  reset(): void;
}

export function createPresenceTracker(opts: {
  onArrive: (id: string, name: string) => Promise<void>;
  onLeave: (id: string) => Promise<void>;
  graceMs?: number;
  presenceWindowMs?: number;
}): PresenceTracker {
  const graceMs = opts.graceMs ?? LEAVE_GRACE_MS;
  const windowMs = opts.presenceWindowMs ?? PRESENCE_WINDOW_MS;
  const connCounts = new Map<string, number>();
  const pendingLeft = new Map<string, NodeJS.Timeout>();
  return {
    async connected(id, name, lastSeenAt) {
      connCounts.set(id, (connCounts.get(id) ?? 0) + 1);
      const pending = pendingLeft.get(id);
      if (pending) {
        // Reconnected within the grace window — they never left.
        clearTimeout(pending);
        pendingLeft.delete(id);
        return false;
      }
      if ((connCounts.get(id) ?? 0) > 1) return false; // another tab already announced them
      // Across a server restart there's no pending timer to cancel — the DB
      // presence window catches that case so a restart doesn't read as an arrival.
      const recentlyPresent = lastSeenAt != null && Date.now() - lastSeenAt.getTime() < windowMs;
      if (recentlyPresent) return false;
      await opts.onArrive(id, name);
      return true;
    },
    disconnected(id) {
      const n = (connCounts.get(id) ?? 1) - 1;
      if (n <= 0) connCounts.delete(id);
      else {
        connCounts.set(id, n);
        return; // another connection is still live
      }
      if (pendingLeft.has(id)) return;
      const timer = setTimeout(() => {
        pendingLeft.delete(id);
        if ((connCounts.get(id) ?? 0) > 0) return; // reconnected meanwhile
        void opts.onLeave(id).catch((err) =>
          console.warn("[presence] departure emit failed:", (err as Error).message),
        );
      }, graceMs);
      // A pending departure notice must never hold the process open.
      timer.unref?.();
      pendingLeft.set(id, timer);
    },
    reset() {
      for (const t of pendingLeft.values()) clearTimeout(t);
      pendingLeft.clear();
      connCounts.clear();
    },
  };
}

// The live tracker the SSE route uses.
const presence = createPresenceTracker({ onArrive: visitorArrived, onLeave: visitorLeft });

export async function visitorConnected(
  id: string,
  name: string,
  lastSeenAt: Date | null,
): Promise<boolean> {
  return presence.connected(id, name, lastSeenAt);
}

export function visitorDisconnected(id: string): void {
  presence.disconnected(id);
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
  // A room change clears the stored zone (Phase C.5) — a new room with no
  // interaction yet means no specific spot is known there.
  await db.update(visitors).set({ locationId: to, zone: null }).where(eq(visitors.id, id));
  await appendEvent({
    type: "visitor.moved",
    visitorId: id,
    locationId: to,
    visibility: "public",
    payload: { visitorId: id, name: row.name, from, to },
  });
  return { from, changed: true };
}

// Record the visitor's approximate within-room spot (Phase C.5, space
// addressing) — set to the zone of whatever fixture they last interacted
// with. Best-effort/approximate by design (the server never tracks raw
// visitor pixels); lets an agent resolve "where the visitor is" with the
// same zone vocabulary used everywhere else.
export async function setVisitorZone(id: string, zone: string): Promise<void> {
  await db.update(visitors).set({ zone }).where(eq(visitors.id, id));
}

// invite_visitor's write path: an agent brought a visitor along (Phase C.5).
// Unlike moveVisitor (the CLIENT reporting a room change it already made),
// this is the SERVER directing the move — it updates the row directly and
// dual-emits: `visitor.moved` keeps the existing location/arrival bookkeeping
// (arrivalTimesAtLocation etc.) consistent with any other move, and
// `visitor.escorted` is the COMMAND the visitor's own client obeys (walks
// their sprite there, full auto-walk). Returns undefined for an unknown
// visitor; the caller (the tool) turns that into an in-fiction miss.
export async function escortVisitorTo(
  visitorId: string,
  agentId: AgentId,
  to: LocationId,
  targetZone?: string,
): Promise<{ from: LocationId | null } | undefined> {
  const [row] = await db.select().from(visitors).where(eq(visitors.id, visitorId));
  if (!row) return undefined;
  const from = (row.locationId ?? null) as LocationId | null;
  await db
    .update(visitors)
    .set({ locationId: to, zone: targetZone ?? null })
    .where(eq(visitors.id, visitorId));
  if (from !== to) {
    await appendEvent({
      type: "visitor.moved",
      visitorId,
      locationId: to,
      visibility: "public",
      payload: { visitorId, name: row.name, from, to },
    });
  }
  await appendEvent({
    type: "visitor.escorted",
    visitorId,
    locationId: to,
    visibility: "public",
    payload: { visitorId, agent: agentId, from: from ?? to, to, targetZone: targetZone ?? null },
  });
  return { from };
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
