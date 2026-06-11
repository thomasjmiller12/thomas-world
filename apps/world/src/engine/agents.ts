// Agent state read/write + the events those state changes emit.
import { eq } from "drizzle-orm";
import type { AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
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

export async function setBusy(id: AgentId, busy: boolean) {
  await db.update(agents).set({ busy }).where(eq(agents.id, id));
}

export async function markTicked(id: AgentId) {
  await db.update(agents).set({ lastTickAt: new Date() }).where(eq(agents.id, id));
}
