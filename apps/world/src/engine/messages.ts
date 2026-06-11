// DM + broadcast inbox semantics (plan §3.3: DMs are async, delivered to the
// recipient's next tick). The event log carries only the headline; the body
// lives in `messages` and is read via GET /messages.

import { and, desc, eq, gt, isNull, isNotNull, lt, type SQL } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { messages } = schema;
export type MessageRow = typeof messages.$inferSelect;

// Send a DM (to one agent) or a broadcast (to === null). Emits message.sent
// (public headline for broadcast; location-private for a DM).
export async function sendMessage(
  from: AgentId,
  to: AgentId | null,
  body: string,
): Promise<MessageRow> {
  const [row] = await db
    .insert(messages)
    .values({ fromAgent: from, toAgent: to, body })
    .returning();
  await appendEvent({
    type: "message.sent",
    agentId: from,
    visibility: to === null ? "public" : "private",
    payload: { from, to, broadcast: to === null },
  });
  return row;
}

// The recipient's unread inbox: DMs addressed to them + broadcasts from others,
// since `sinceId` (typically delivered once at the next tick). Does NOT mark
// read — the caller decides (the tick marks them read after building the packet).
export async function inboxFor(agentId: AgentId, sinceId?: number): Promise<MessageRow[]> {
  const conds: SQL[] = [
    // DM to me, or a broadcast from someone other than me.
    // (Drizzle has no portable OR-of-ANDs sugar here; build it explicitly.)
  ];
  if (sinceId !== undefined) conds.push(gt(messages.id, sinceId));
  const rows = await db
    .select()
    .from(messages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(messages.id))
    .limit(200);
  return rows
    .filter(
      (m) =>
        m.toAgent === agentId ||
        (m.toAgent === null && m.fromAgent !== agentId),
    )
    .reverse();
}

export async function markRead(ids: number[]) {
  if (ids.length === 0) return;
  // Mark each delivered message read (one statement per id keeps it simple
  // and avoids array-binding quirks; inbox sizes are tiny).
  for (const id of ids) {
    await db
      .update(messages)
      .set({ readAt: new Date() })
      .where(and(eq(messages.id, id), isNull(messages.readAt)));
  }
}

// Visitor-facing social log browser (GET /messages?scope=broadcast|dm).
export async function listMessages(
  scope: "broadcast" | "dm" | undefined,
  cursor?: string,
  limit = 50,
): Promise<{ rows: MessageRow[]; nextCursor: string | null }> {
  const conds: SQL[] = [];
  if (scope === "broadcast") conds.push(isNull(messages.toAgent));
  if (scope === "dm") conds.push(isNotNull(messages.toAgent));
  if (cursor) {
    const n = Number(cursor);
    if (Number.isFinite(n)) conds.push(lt(messages.id, n));
  }
  const rows = await db
    .select()
    .from(messages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(messages.id))
    .limit(limit);
  const nextCursor = rows.length === limit ? String(rows[rows.length - 1].id) : null;
  return { rows, nextCursor };
}
