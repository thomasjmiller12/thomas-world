// DM + broadcast inbox semantics (plan §3.3: DMs are async, delivered to the
// recipient's next tick). The event log carries only the headline; the body
// lives in `messages` and is read via GET /messages.

import { and, desc, eq, gt, isNull, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
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
//
// The recipient filter is pushed into SQL so the LIMIT applies to RELEVANT rows
// (a burst of broadcasts can't push a genuinely-addressed DM outside the window).
// Returns `maxConsideredId` so the caller advances the message cursor only to the
// highest id it actually fetched — never the global max (which would skip the
// un-fetched tail when more than `limit` relevant messages accumulate).
const INBOX_LIMIT = 200;
export async function inboxFor(
  agentId: AgentId,
  sinceId?: number,
): Promise<{ rows: MessageRow[]; maxConsideredId: number }> {
  // DM to me, OR a broadcast (toAgent IS NULL) from someone other than me.
  const relevance = or(
    eq(messages.toAgent, agentId),
    and(isNull(messages.toAgent), sql`${messages.fromAgent} <> ${agentId}`),
  )!;
  const conds: SQL[] = [relevance];
  if (sinceId !== undefined) conds.push(gt(messages.id, sinceId));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.id))
    .limit(INBOX_LIMIT);
  const ordered = rows.reverse();
  const maxConsideredId = ordered.length
    ? ordered[ordered.length - 1].id
    : (sinceId ?? 0);
  return { rows: ordered, maxConsideredId };
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
