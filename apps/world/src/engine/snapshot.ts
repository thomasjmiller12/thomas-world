// Builds the GET /world/snapshot payload (plan §5) for initial frontend render.
import { sql, gt } from "drizzle-orm";
import type { SnapshotResponse, AgentStatus, ActiveConversation, AgentId, LocationId } from "@town/contract";
import { db } from "../db/client.js";
import { visitors } from "../db/schema.js";
import type { Engagement } from "../db/schema.js";
import { currentPhase, isOvernight } from "../runtime/clock.js";
import { allAgents } from "./agents.js";
import { activeConversations } from "./conversations.js";
import { recentEvents } from "./events.js";
import { isBudgetExhausted } from "./usage.js";

// Project a stored Engagement row onto the contract's AgentStatus.engagement
// shape (design doc §5): `with` is the OTHER participants plus the literal
// 'visitor' when it's a chat (a visitor is always present in a chat session).
export function engagementToContract(
  e: Engagement | null | undefined,
): AgentStatus["engagement"] {
  if (!e) return undefined;
  const withList: (AgentId | "visitor")[] = [...e.participants];
  if (e.kind === "chat") withList.push("visitor");
  return { kind: e.kind, with: withList };
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
  const [agentRows, convs, events, present, budgetExhausted] = await Promise.all([
    allAgents(),
    activeConversations(),
    recentEvents(30),
    visitorsPresent(),
    isBudgetExhausted(),
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

  const conversations: ActiveConversation[] = convs.map((c) => ({
    id: c.id,
    locationId: c.locationId as LocationId,
    participantIds: c.participantIds as AgentId[],
    startedAt: c.startedAt.toISOString(),
  }));

  // `awake` is false when the town is asleep (overnight) OR the daily budget is
  // exhausted (design doc §7 — the frontend renders "dream mode" either way;
  // reads stay live). The clock alone drove this before the budget signal wired.
  const world = {
    phase: currentPhase(),
    visitorsPresent: present,
    awake: !isOvernight() && !budgetExhausted,
  };

  return { agents, conversations, recentEvents: events, world };
}
