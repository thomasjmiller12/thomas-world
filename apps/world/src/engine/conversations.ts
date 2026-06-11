// Conversation scene records (agent↔agent dialogue, plan §4.1). The runtime
// phase drives the bounded synchronous exchange; the engine just persists the
// scene + each turn and emits the matching events.

import { eq, isNull, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { conversations, conversationTurns } = schema;
export type ConversationRow = typeof conversations.$inferSelect;

export async function startConversation(
  location: LocationId,
  participants: AgentId[],
): Promise<ConversationRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(conversations)
    .values({ id, locationId: location, participantIds: participants })
    .returning();
  await appendEvent({
    type: "conversation.started",
    locationId: location,
    visibility: "location",
    payload: { conversationId: id, location, participants },
  });
  return row;
}

export async function addTurn(
  conversationId: string,
  agentId: AgentId,
  body: string,
) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  await db.insert(conversationTurns).values({ conversationId, agentId, body });
  await appendEvent({
    type: "conversation.turn",
    agentId,
    locationId: conv?.locationId as LocationId | undefined,
    visibility: "location",
    payload: { conversationId, agent: agentId, text: body },
  });
}

export async function endConversation(conversationId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv) return;
  await db
    .update(conversations)
    .set({ endedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  await appendEvent({
    type: "conversation.ended",
    locationId: conv.locationId as LocationId,
    visibility: "location",
    payload: {
      conversationId,
      participants: conv.participantIds as AgentId[],
    },
  });
}

// Currently-open scenes (snapshot's activeConversations).
export async function activeConversations(): Promise<ConversationRow[]> {
  return db.select().from(conversations).where(isNull(conversations.endedAt));
}

export async function turnsFor(conversationId: string) {
  return db
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversationId));
}
