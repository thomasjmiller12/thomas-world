// Visitor presence (plan §3.1). Presence is keyed to an SSE connection's
// lifetime: register on connect (visitor.arrived), drop on disconnect
// (visitor.left). Arrivals/departures are world events agents perceive.

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { visitors } = schema;
export type VisitorRow = typeof visitors.$inferSelect;

export async function registerVisitor(name: string): Promise<VisitorRow> {
  const id = randomUUID();
  const [row] = await db.insert(visitors).values({ id, name }).returning();
  return row;
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
