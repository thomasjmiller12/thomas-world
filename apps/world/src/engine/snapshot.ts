// Builds the GET /world/snapshot payload (plan §5) for initial frontend render.
import type { SnapshotResponse, AgentStatus, ActiveConversation, AgentId, LocationId } from "@town/contract";
import { allAgents } from "./agents.js";
import { activeConversations } from "./conversations.js";
import { recentEvents } from "./events.js";

export async function buildSnapshot(): Promise<SnapshotResponse> {
  const [agentRows, convs, events] = await Promise.all([
    allAgents(),
    activeConversations(),
    recentEvents(30),
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

  return { agents, conversations, recentEvents: events };
}
