// Builds the GET /world/snapshot payload (plan §5) for initial frontend render.
import { sql, gt } from "drizzle-orm";
import type { SnapshotResponse, AgentStatus, AgentId, LocationId } from "@town/contract";
import { db } from "../db/client.js";
import { visitors } from "../db/schema.js";
import type { Engagement } from "../db/schema.js";
import { currentPhase, isOvernight } from "../runtime/clock.js";
import { allAgents } from "./agents.js";
import { recentEvents } from "./events.js";
import { isBudgetExhausted } from "./usage.js";
import { allObjects, rowToWorldObject } from "./objects.js";
import { allZones } from "./zones.js";

// Project a stored Engagement row onto the contract's AgentStatus.engagement
// shape (design doc §5): `with` is the OTHER participants plus the literal
// 'visitor' (a visitor is always present in a chat session). Only `chat`
// engagements exist post-M2.1 (paced scenes are gone); a stale `scene`
// engagement (only possible from a pre-M2.1 row the boot sweep hasn't cleared
// yet) projects to undefined rather than a kind the contract no longer allows.
export function engagementToContract(
  e: Engagement | null | undefined,
): AgentStatus["engagement"] {
  if (!e || e.kind !== "chat") return undefined;
  const withList: (AgentId | "visitor")[] = [...e.participants, "visitor"];
  return { kind: "chat", with: withList };
}

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
    // Derived from engagement (design doc §3.2): busy === engagement != null.
    busy: a.engagement != null,
    engagement: engagementToContract(a.engagement),
    lastTickAt: a.lastTickAt ? a.lastTickAt.toISOString() : null,
  }));

  // `awake` is false when the town is asleep (overnight) OR the daily budget is
  // exhausted (design doc §7 — the frontend renders "dream mode" either way;
  // reads stay live). The clock alone drove this before the budget signal wired.
  const world = {
    phase: currentPhase(),
    visitorsPresent: present,
    awake: !isOvernight() && !budgetExhausted,
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
