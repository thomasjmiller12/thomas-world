// Human-readable rendering of world events for GET /feed and /debug — the
// "day-in-the-life" surface (plan §5, §7). One line per event.

import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { WorldEvent, WorldEventType, AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";

const { worldEvents, agents } = schema;

// Display names cached lazily so feed lines read "Builder Thomas", not "builder".
let nameCache: Record<string, string> | null = null;
async function displayName(id: string | null | undefined): Promise<string> {
  if (!id) return "someone";
  if (!nameCache) {
    const rows = await db.select().from(agents);
    nameCache = Object.fromEntries(rows.map((r) => [r.id, r.displayName]));
  }
  return nameCache[id] ?? id;
}

// Render one event to a human line. Async because it resolves display names.
export async function renderLine(e: WorldEvent): Promise<string> {
  const p = e.payload as Record<string, unknown>;
  const who = async (a: unknown) => displayName(a as string);
  switch (e.type) {
    case "agent.moved":
      return `${await who(p.agent)} walked from ${p.from} to ${p.to}.`;
    case "agent.activity":
      return `${await who(p.agent)} is ${p.activity}.`;
    case "agent.thought":
      return `${await who(p.agent)} thought: "${p.text}"`;
    case "agent.spoke":
      return `${await who(p.agent)} said (in ${p.location}): "${p.text}"`;
    case "conversation.started": {
      const names = await Promise.all((p.participants as string[]).map(who));
      return `${names.join(" and ")} started talking in ${p.location}.`;
    }
    case "conversation.turn":
      return `${await who(p.agent)}: "${p.text}"`;
    case "conversation.ended":
      return `The conversation wrapped up.`;
    case "conversation.converted":
      return `A visitor joined the conversation.`;
    case "chat.joined":
      return `${await who(p.agent)} joined the conversation.`;
    case "message.sent":
      return p.broadcast
        ? `${await who(p.from)} broadcast a message to everyone.`
        : `${await who(p.from)} sent a DM to ${await who(p.to)}.`;
    case "artifact.created":
      return `${await who(p.agent)} made a ${p.kind}: "${p.title}"${
        p.location ? ` (at the ${p.fixture ?? p.location})` : ""
      }.`;
    case "artifact.updated":
      return `${await who(p.agent)} updated "${p.title}".`;
    case "bulletin.posted":
      return `${await who(p.agent)} posted a bulletin: "${p.title}".`;
    case "capability.requested":
      return `${await who(p.agent)} requested a new capability: ${p.summary}`;
    case "visitor.arrived":
      return `${p.name} arrived in town.`;
    case "visitor.left":
      return `${p.name} left town.`;
    case "visitor.moved":
      return p.from
        ? `${p.name} wandered from ${p.from} to ${p.to}.`
        : `${p.name} wandered into ${p.to}.`;
    case "visitor.interacted":
      return p.fixture === "phone"
        ? `${p.name} answered the phone in ${p.location}.`
        : `${p.name} fiddled with the ${p.fixture} in ${p.location}.`;
    case "world.effect":
      return p.fixture === "phone" && p.effect === "ring"
        ? `The office phone rang. Nobody knows why.`
        : `The ${p.fixture} ${p.effect}ed in ${p.location}.`;
    case "chat.started":
      return `${await who(p.agent)} started chatting with a visitor.`;
    case "chat.ended":
      return `${await who(p.agent)} finished a visitor conversation.`;
    case "world.time":
      return `It's now ${p.phase}.`;
    default:
      return `(unknown event)`;
  }
}

export interface FeedRow {
  id: string;
  ts: string;
  agent: AgentId | null;
  line: string;
  // M2 (design doc §5): source event type (drives feed icons/filters), the
  // location it happened in (drives "⌖ SHOW IN TOWN"), and the recipient for
  // directed events like message.sent (null otherwise).
  type: WorldEventType | null;
  locationId: LocationId | null;
  to: AgentId | null;
}

// Paginated feed (newest-first with a descending-id cursor). Public surface, so
// it shows public + location events but hides private interior monologue DMs.
// Returns `count` (the number of items on this page) per the contract.
export async function getFeed(
  agent?: AgentId,
  cursor?: string,
  limit = 50,
): Promise<{ items: FeedRow[]; nextCursor: string | null; count: number }> {
  const conds: SQL[] = [];
  if (agent) conds.push(eq(worldEvents.agentId, agent));
  if (cursor) {
    const n = Number(cursor);
    if (Number.isFinite(n)) conds.push(lt(worldEvents.id, n));
  }
  const rows = await db
    .select()
    .from(worldEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(worldEvents.id))
    .limit(limit);

  const visible = rows.filter((r) => r.visibility !== "private");
  const items: FeedRow[] = [];
  for (const r of visible) {
    const e: WorldEvent = {
      id: String(r.id),
      ts: r.ts.toISOString(),
      type: r.type as WorldEvent["type"],
      agentId: (r.agentId ?? null) as AgentId | null,
      locationId: r.locationId as never,
      visitorId: r.visitorId ?? null,
      visibility: r.visibility as never,
      payload: r.payload as never,
    } as WorldEvent;
    items.push(enrichFeedRow(e, await renderLine(e)));
  }
  const nextCursor = rows.length === limit ? String(rows[rows.length - 1].id) : null;
  return { items, nextCursor, count: items.length };
}

// Build a FeedRow from a (public) event + its rendered line. Pure (no DB) so the
// M2 enrichment — `type`, `locationId`, and `to` (the recipient for directed
// message.sent DMs; null otherwise) — is unit-testable in isolation.
export function enrichFeedRow(e: WorldEvent, line: string): FeedRow {
  const payload = e.payload as Record<string, unknown>;
  const to =
    e.type === "message.sent" && typeof payload.to === "string"
      ? (payload.to as AgentId)
      : null;
  return {
    id: e.id,
    ts: e.ts,
    agent: (e.agentId ?? null) as AgentId | null,
    line,
    type: e.type,
    locationId: (e.locationId ?? null) as LocationId | null,
    to,
  };
}
