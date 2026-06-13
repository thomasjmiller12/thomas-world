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

// --- engagement (legacy, M3) -----------------------------------------------
// The `engagement` column predates M3's input queue, which now serializes an
// agent's turns (no "one body, one conversation" lock needed). Nothing SETS
// engagement anymore — the boot sweep clears any stale value — but the column +
// the derived `busy` boolean are kept so the snapshot/debug contract is stable.

export type { Engagement };

// Derive the contract's `busy` boolean from an engagement reference (always null
// in M3, so always false — retained for the snapshot contract).
export function isBusy(engagement: Engagement | null | undefined): boolean {
  return engagement != null;
}

export async function markTicked(id: AgentId) {
  await db.update(agents).set({ lastTickAt: new Date() }).where(eq(agents.id, id));
}
