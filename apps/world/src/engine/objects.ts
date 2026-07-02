// World-object engine (MUD embodiment). READ helpers over the world_objects
// table plus the write paths: appendNote (leave_note), setObjectState (the
// director's object surface), and — since the programmable-world slice — the
// structural verbs createObject / moveObject / removeObject / attachArtifact
// behind place_object / move_object / remove_object / mount_artifact. Each
// write emits its object.* event; the renderer materializes changes live.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  AgentId,
  LocationId,
  ObjectNote,
  ObjectPlacement,
  WorldObject,
  WorldObjectState,
} from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";
import { defaultZone, zoneExists, zonesForLocation } from "./zones.js";

const { worldObjects, artifacts } = schema;

export type WorldObjectRow = typeof worldObjects.$inferSelect;

// Map a DB row to the contract WorldObject (timestamps → ISO strings on wire).
export function rowToWorldObject(row: WorldObjectRow): WorldObject {
  return {
    id: row.id,
    template: row.template ?? null,
    displayName: row.displayName,
    locationId: row.locationId as LocationId,
    zone: row.zone,
    placement: (row.placement ?? null) as ObjectPlacement | null,
    state: (row.state ?? {}) as WorldObjectState,
    affordances: (row.affordances ?? []) as string[],
    kind: row.kind ?? null,
    attachedArtifactIds: (row.attachedArtifactIds ?? []) as string[],
    notes: (row.notes ?? []) as ObjectNote[],
    ownerAgentId: (row.ownerAgentId ?? null) as AgentId | null,
    description: row.description ?? null,
    movable: row.movable,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function allObjects(): Promise<WorldObjectRow[]> {
  return db.select().from(worldObjects).orderBy(asc(worldObjects.id));
}

// --- reads ------------------------------------------------------------------

export async function objectsAtLocation(locationId: LocationId): Promise<WorldObjectRow[]> {
  return db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.locationId, locationId))
    .orderBy(asc(worldObjects.id));
}

export async function objectsInZone(
  locationId: LocationId,
  zone: string,
): Promise<WorldObjectRow[]> {
  return db
    .select()
    .from(worldObjects)
    .where(and(eq(worldObjects.locationId, locationId), eq(worldObjects.zone, zone)))
    .orderBy(asc(worldObjects.id));
}

export async function getObject(id: string): Promise<WorldObjectRow | undefined> {
  const [row] = await db.select().from(worldObjects).where(eq(worldObjects.id, id));
  return row;
}

export async function objectsByOwner(agentId: AgentId): Promise<WorldObjectRow[]> {
  return db
    .select()
    .from(worldObjects)
    .where(eq(worldObjects.ownerAgentId, agentId))
    .orderBy(asc(worldObjects.id));
}

// The artifact rows attached to an object (back-reference via artifacts.objectId
// OR the denormalized attachedArtifactIds list — both are populated by the
// attach path; we read the denormalized list as the fast source).
export async function attachedArtifactsFor(
  objectId: string,
): Promise<(typeof artifacts.$inferSelect)[]> {
  const obj = await getObject(objectId);
  const ids = (obj?.attachedArtifactIds ?? []) as string[];
  if (ids.length === 0) {
    // Fall back to the back-reference column so a divergent denorm still reads.
    return db.select().from(artifacts).where(eq(artifacts.objectId, objectId));
  }
  return db.select().from(artifacts).where(inArray(artifacts.id, ids));
}

// Resolve a free-string object reference (a displayName or id) to a row AT a
// given location. Used by inspect_object/leave_note so the agent can name an
// object the way perception shows it. Case-insensitive on displayName.
export async function findObjectAtLocation(
  locationId: LocationId,
  ref: string,
): Promise<WorldObjectRow | undefined> {
  const here = await objectsAtLocation(locationId);
  const needle = ref.trim().toLowerCase();
  return (
    here.find((o) => o.id === ref) ??
    here.find((o) => o.displayName.toLowerCase() === needle) ??
    here.find((o) => o.displayName.toLowerCase().includes(needle))
  );
}

// --- writes -----------------------------------------------------------------

// appendNote: the leave_note write path. Appends a short note to an object (or,
// when `objectId` is null, anchors it to a bare zone) and emits object.noted.
// `zone` is required when no object is targeted. Returns the rendered confirmation.
export async function appendNote(
  target: { objectId: string | null; zone?: string },
  agent: AgentId,
  location: LocationId,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  let zone = target.zone;
  if (target.objectId) {
    const obj = await getObject(target.objectId);
    if (!obj || obj.locationId !== location) {
      return { ok: false, reason: "object-not-here" };
    }
    const note: ObjectNote = { agent, text, ts: new Date().toISOString() };
    const notes = [...((obj.notes ?? []) as ObjectNote[]), note];
    await db
      .update(worldObjects)
      .set({ notes, updatedAt: new Date() })
      .where(eq(worldObjects.id, target.objectId));
    zone = obj.zone;
  } else {
    if (!zone || !zoneExists(zone, location)) {
      return { ok: false, reason: "zone-not-here" };
    }
  }

  await appendEvent({
    type: "object.noted",
    agentId: agent,
    locationId: location,
    visibility: "location",
    payload: {
      objectId: target.objectId,
      zone: zone ?? defaultZone(location),
      agent,
      location,
      text,
    },
  });
  return { ok: true };
}

// --- structural writes (programmable world, D2) ------------------------------
// The control-verb slice the foundation stubbed for. Every write emits its
// forward-ready event so the renderer materializes the change live.

export interface CreateObjectInput {
  id: string;
  agent: AgentId;
  location: LocationId;
  zone: string;
  template?: string | null;
  displayName: string;
  kind?: string | null;
  description?: string | null;
  affordances?: string[];
}

// Pick a renderer placement point inside a zone's bounds: bottom-center-ish
// with a deterministic-per-id horizontal scatter so several objects placed in
// one zone don't stack pixel-perfectly. Zones without bounds → null (the
// renderer falls back to the zone/room anchor).
export function placementForZone(
  location: LocationId,
  zoneId: string,
  seedKey: string,
): ObjectPlacement | null {
  const zone = (zonesForLocation(location) ?? []).find((z) => z.id === zoneId);
  const b = zone?.bounds;
  if (!b) return null;
  let h = 2166136261;
  for (let i = 0; i < seedKey.length; i++) h = (h ^ seedKey.charCodeAt(i)) * 16777619;
  const frac = ((h >>> 0) % 1000) / 1000;
  const x = Math.round(b.x + 6 + frac * Math.max(1, b.w - 12));
  const y = Math.round(b.y + b.h - 2);
  return { scene: b.scene, x, y };
}

export async function createObject(input: CreateObjectInput): Promise<WorldObjectRow> {
  const placement = placementForZone(input.location, input.zone, input.id);
  const [row] = await db
    .insert(worldObjects)
    .values({
      id: input.id,
      template: input.template ?? null,
      displayName: input.displayName,
      locationId: input.location,
      zone: input.zone,
      placement,
      kind: input.kind ?? null,
      description: input.description ?? null,
      affordances: input.affordances ?? [],
      movable: true,
      ownerAgentId: input.agent,
    })
    .returning();
  await appendEvent({
    type: "object.created",
    agentId: input.agent,
    locationId: input.location,
    visibility: "public",
    payload: {
      objectId: row.id,
      agent: input.agent,
      location: input.location,
      zone: input.zone,
      template: row.template ?? null,
      displayName: row.displayName,
      placement: placement ? { scene: placement.scene, x: placement.x, y: placement.y } : null,
    },
  });
  return row;
}

export async function moveObject(
  objectId: string,
  agent: AgentId,
  toZone: string,
): Promise<{ ok: boolean; reason?: string }> {
  const obj = await getObject(objectId);
  if (!obj) return { ok: false, reason: "object-missing" };
  if (!obj.movable) return { ok: false, reason: "immovable" };
  const location = obj.locationId as LocationId;
  if (!zoneExists(toZone, location)) return { ok: false, reason: "zone-not-here" };
  const fromZone = obj.zone;
  const placement = placementForZone(location, toZone, obj.id);
  await db
    .update(worldObjects)
    .set({ zone: toZone, placement, updatedAt: new Date() })
    .where(eq(worldObjects.id, objectId));
  await appendEvent({
    type: "object.moved",
    agentId: agent,
    locationId: location,
    visibility: "location",
    payload: { objectId, agent, location, fromZone, toZone },
  });
  return { ok: true };
}

// Remove an agent-placed object. Seeded fixtures (movable: false) are
// structural and refuse; anything movable is fair game — the town is a commons.
export async function removeObject(
  objectId: string,
  agent: AgentId,
): Promise<{ ok: boolean; reason?: string; displayName?: string }> {
  const obj = await getObject(objectId);
  if (!obj) return { ok: false, reason: "object-missing" };
  if (!obj.movable) return { ok: false, reason: "immovable" };
  await db.delete(worldObjects).where(eq(worldObjects.id, objectId));
  await appendEvent({
    type: "object.removed",
    agentId: agent,
    locationId: obj.locationId as LocationId,
    visibility: "public",
    payload: {
      objectId,
      agent,
      location: obj.locationId,
      displayName: obj.displayName,
    },
  });
  return { ok: true, displayName: obj.displayName };
}

// setObjectState: the Director/Effect object-surface write path. Loads the
// object, shallow-merges `statePatch` into its `state` bag, bumps updatedAt,
// persists, and emits the canonical `object.state_changed` (visibility:location,
// the perception layer renders it). Returns an in-fiction-friendly result rather
// than throwing so the director dispatcher can surface a graceful reason.
export async function setObjectState(
  objectId: string,
  agent: AgentId | null,
  effect: string,
  statePatch?: WorldObjectState,
): Promise<{ ok: boolean; reason?: string }> {
  const obj = await getObject(objectId);
  if (!obj) return { ok: false, reason: "object-missing" };

  const mergedState: WorldObjectState = {
    ...((obj.state ?? {}) as WorldObjectState),
    ...(statePatch ?? {}),
  };
  await db
    .update(worldObjects)
    .set({ state: mergedState, updatedAt: new Date() })
    .where(eq(worldObjects.id, objectId));

  await appendEvent({
    type: "object.state_changed",
    agentId: agent,
    locationId: obj.locationId as LocationId,
    visibility: "location",
    payload: {
      objectId,
      agent,
      location: obj.locationId,
      effect,
      state: mergedState,
    },
  });
  return { ok: true };
}

// Mount an artifact on an object (programmable world, D1). Denormalizes onto
// worldObjects.attachedArtifactIds AND back-references artifacts.objectId, then
// emits object.attached — the renderer's cue to make the object's sprite
// clickable (click opens the most recently attached artifact). Re-attaching an
// already-attached artifact moves it to the end (it becomes the click target).
export async function attachArtifact(
  objectId: string,
  artifactId: string,
  agent: AgentId,
): Promise<{ ok: boolean; reason?: string }> {
  const obj = await getObject(objectId);
  if (!obj) return { ok: false, reason: "object-missing" };
  const [art] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId));
  if (!art) return { ok: false, reason: "artifact-missing" };

  const ids = ((obj.attachedArtifactIds ?? []) as string[]).filter((id) => id !== artifactId);
  ids.push(artifactId);
  await db
    .update(worldObjects)
    .set({ attachedArtifactIds: ids, updatedAt: new Date() })
    .where(eq(worldObjects.id, objectId));
  await db.update(artifacts).set({ objectId }).where(eq(artifacts.id, artifactId));

  await appendEvent({
    type: "object.attached",
    agentId: agent,
    locationId: obj.locationId as LocationId,
    visibility: "public",
    payload: {
      objectId,
      artifactId,
      agent,
      location: obj.locationId,
      kind: art.kind,
      title: art.title,
    },
  });
  return { ok: true };
}

// Recent world events touching one object (for inspect_object's history view):
// object.noted / object.state_changed / world.effect rows whose payload names it.
export async function recentObjectEvents(
  objectId: string,
  displayName: string,
  limit = 5,
): Promise<{ ts: string; line: string }[]> {
  const rows = await db
    .select()
    .from(schema.worldEvents)
    .where(
      sql`${schema.worldEvents.type} in ('object.noted','object.state_changed','world.effect')`,
    )
    .orderBy(desc(schema.worldEvents.id))
    .limit(40);
  const out: { ts: string; line: string }[] = [];
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const matches =
      p.objectId === objectId ||
      (typeof p.fixture === "string" && p.fixture.toLowerCase() === displayName.toLowerCase());
    if (!matches) continue;
    const ts = r.ts.toISOString();
    if (r.type === "object.noted") out.push({ ts, line: `${p.agent} jotted: "${p.text}"` });
    else if (r.type === "object.state_changed")
      out.push({ ts, line: `${p.agent ?? "something"}: ${p.effect}` });
    else out.push({ ts, line: `${p.agent ?? "someone"} ${p.effect} it` });
    if (out.length >= limit) break;
  }
  return out;
}
