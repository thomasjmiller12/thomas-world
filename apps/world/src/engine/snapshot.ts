// Builds the GET /world/snapshot payload (plan §5) for initial frontend render.
import { sql, gt } from "drizzle-orm";
import type { SnapshotResponse, AgentStatus, AgentId, LocationId } from "@town/contract";
import { db } from "../db/client.js";
import { visitors } from "../db/schema.js";
import { currentPhase } from "../runtime/clock.js";
import { allAgents } from "./agents.js";
import { recentEvents } from "./events.js";
import { isBudgetExhausted } from "./usage.js";
import { allObjects, rowToWorldObject } from "./objects.js";
import { allZones } from "./zones.js";

// Visitors seen within the last 2 minutes count as "present in town" — same
// liveness window the observation packet uses.
async function visitorsPresent(): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(visitors)
    .where(gt(visitors.lastSeenAt, cutoff));
  return Number(row?.n ?? 0);
}

// Passive agents sleep on the scheduler's overnight clock, but visitor chat is
// interrupt-driven and remains available at every phase. `awake` therefore
// means "interactive requests can run", not "autonomous ticks are running".
export function interactiveAvailability(budgetExhausted: boolean): boolean {
  return !budgetExhausted;
}

export async function buildSnapshot(): Promise<SnapshotResponse> {
  const [agentRows, events, present, budgetExhausted, objectRows] = await Promise.all([
    allAgents(),
    recentEvents(30),
    visitorsPresent(),
    isBudgetExhausted(),
    allObjects(),
  ]);

  const agents: AgentStatus[] = agentRows.map((a) => ({
    id: a.id as AgentId,
    displayName: a.displayName,
    locationId: a.locationId as LocationId,
    status: a.status,
    activity: a.activity ?? null,
    lastTickAt: a.lastTickAt ? a.lastTickAt.toISOString() : null,
  }));

  // Night still drives the tint and pauses passive ticks, but it must not put an
  // active visitor chat into dream mode. Only the hard budget gate removes
  // interactive availability.
  const world = {
    phase: currentPhase(),
    visitorsPresent: present,
    awake: interactiveAvailability(budgetExhausted),
  };

  return {
    agents,
    recentEvents: events,
    world,
    // MUD embodiment (additive): the canonical object graph + zone registry.
    objects: objectRows.map(rowToWorldObject),
    zones: allZones(),
  };
}
