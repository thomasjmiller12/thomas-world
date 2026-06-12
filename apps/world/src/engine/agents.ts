// Agent state read/write + the events those state changes emit.
import { eq, sql } from "drizzle-orm";
import type { AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import type { Engagement } from "../db/schema.js";
import { appendEvent } from "./events.js";

const { agents } = schema;
export type AgentRow = typeof agents.$inferSelect;

export async function getAgent(id: AgentId): Promise<AgentRow | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row;
}

export async function allAgents(): Promise<AgentRow[]> {
  return db.select().from(agents);
}

// Move an agent and emit agent.moved (public — movement is visible to all).
export async function moveAgent(id: AgentId, to: LocationId) {
  const agent = await getAgent(id);
  if (!agent) throw new Error(`unknown agent: ${id}`);
  const from = agent.locationId as LocationId;
  await db.update(agents).set({ locationId: to }).where(eq(agents.id, id));
  if (from !== to) {
    await appendEvent({
      type: "agent.moved",
      agentId: id,
      locationId: to,
      visibility: "public",
      payload: { agent: id, from, to },
    });
  }
}

// Update the activity line and emit agent.activity (public).
export async function setActivity(id: AgentId, activity: string) {
  await db.update(agents).set({ activity }).where(eq(agents.id, id));
  await appendEvent({
    type: "agent.activity",
    agentId: id,
    visibility: "public",
    payload: { agent: id, activity },
  });
}

export async function setStatus(id: AgentId, status: string) {
  await db.update(agents).set({ status }).where(eq(agents.id, id));
}

// --- engagement (design doc §3.2) ------------------------------------------
// `engagement` replaces the old `busy` boolean. An agent is engaged in at most
// one chat or scene at a time ("one body, one conversation"); the derived
// `busy` boolean is simply `engagement != null`.

export type { Engagement };

// Derive the contract's `busy` boolean from an engagement reference.
export function isBusy(engagement: Engagement | null | undefined): boolean {
  return engagement != null;
}

// Set the same engagement on every participant of a session (the kind/id pair).
// `participants` is the FULL roster; each row records the OTHER participants so
// clearEngagement can release them all, and the contract's `with` can be derived.
export async function setEngagement(
  kind: Engagement["kind"],
  id: string,
  participants: AgentId[],
): Promise<void> {
  for (const a of participants) {
    const others = participants.filter((p) => p !== a);
    await db
      .update(agents)
      .set({ engagement: { kind, id, participants: others } })
      .where(eq(agents.id, a));
  }
}

// Clear engagement on EVERY agent currently engaged in (kind, id) — the single
// owner of un-engaging. Matching by the jsonb kind+id (not a participant list)
// means a stranded holder is always freed, even if the participant arrays drift.
// Returns the agent ids that were cleared.
export async function clearEngagement(
  kind: Engagement["kind"],
  id: string,
): Promise<AgentId[]> {
  const cleared = await db
    .update(agents)
    .set({ engagement: null })
    .where(
      sql`${agents.engagement} ->> 'kind' = ${kind} AND ${agents.engagement} ->> 'id' = ${id}`,
    )
    .returning({ id: agents.id });
  return cleared.map((c) => c.id as AgentId);
}

export async function markTicked(id: AgentId) {
  await db.update(agents).set({ lastTickAt: new Date() }).where(eq(agents.id, id));
}
