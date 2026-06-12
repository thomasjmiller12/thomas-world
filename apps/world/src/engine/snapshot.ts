// Builds the GET /world/snapshot payload (plan §5) for initial frontend render.
import { sql, gt } from "drizzle-orm";
import type { SnapshotResponse, AgentStatus, ActiveConversation, AgentId, LocationId } from "@town/contract";
import { db } from "../db/client.js";
import { visitors } from "../db/schema.js";
import { currentPhase, isOvernight } from "../runtime/clock.js";
import { allAgents } from "./agents.js";
import { activeConversations } from "./conversations.js";
import { recentEvents } from "./events.js";

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
  const [agentRows, convs, events, present] = await Promise.all([
    allAgents(),
    activeConversations(),
    recentEvents(30),
    visitorsPresent(),
  ]);

  const agents: AgentStatus[] = agentRows.map((a) => ({
    id: a.id as AgentId,
    displayName: a.displayName,
    locationId: a.locationId as LocationId,
    status: a.status,
    activity: a.activity ?? null,
    busy: a.busy,
    lastTickAt: a.lastTickAt ? a.lastTickAt.toISOString() : null,
  }));

  const conversations: ActiveConversation[] = convs.map((c) => ({
    id: c.id,
    locationId: c.locationId as LocationId,
    participantIds: c.participantIds as AgentId[],
    startedAt: c.startedAt.toISOString(),
  }));

  // `engagement` is intentionally NOT populated yet — the `engagement` column
  // migration lands in step A2/§3.2; `busy` remains the source of truth here.
  // `awake` derives from the clock until the budget-exhaustion signal is wired
  // (step B / §7); a sleeping-by-budget town is reported via /health today.
  const world = {
    phase: currentPhase(),
    visitorsPresent: present,
    awake: !isOvernight(),
  };

  return { agents, conversations, recentEvents: events, world };
}
