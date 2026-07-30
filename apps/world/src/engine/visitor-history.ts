// Visitor HISTORY — the "person tier" the memory architecture was missing.
//
// The M3 design has three memory layers (thread / core memory / episodic-by-pull)
// and they all work. What it never had was any binding between them and the
// PERSON standing in the room. Concretely, before this module:
//
//   - `renderVisitorsSection` told the agent a name, an approximate zone, and a
//     coarse arrival time. Never "you have met this person before."
//   - `runVisitorInput` interpolated only `visitorName` — a free-text field the
//     visitor can change — so the agent had no durable handle on anyone.
//   - Nothing wrote a visit to episodic memory, so the `recall` tool (which the
//     agents DO use, 74 times across the five threads) always came back empty.
//
// The result, in Career Thomas's own words to Thomas on 2026-07-13: "I ran a
// recall on you specifically before you even said who you were, and nothing came
// back." This module supplies the missing facts.

import { and, desc, eq, or, sql } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";

const { chatSessions, chatMessages, visitors } = schema;

export interface VisitorHistory {
  /** The stable visitor id this history was computed for. */
  visitorId: string;
  /** Display name as of now. */
  name: string;
  /**
   * How many prior CONVERSATIONS this agent has had with this person, counted as
   * distinct days rather than distinct session rows.
   *
   * Sessions are the wrong unit: the frontend hard-closes and reopens a session
   * when the visitor switches agents or reopens the panel, so a single afternoon
   * of talking can produce several rows. Counting rows told Thomas "you've talked
   * 6 times before" for what he experienced as one visit. Days match how a person
   * actually remembers meeting someone.
   */
  priorSessions: number;
  /** When the most recent PRIOR conversation with this agent started. */
  lastSeenAt: Date | null;
  /** Every visitor row id folded into this identity (see `identityIds`). */
  aliasIds: string[];
}

// PRIMARY identity is the durable `town.visitorId` the browser keeps in
// localStorage — that alone covers the common case (same person, same browser,
// returning weeks later) and is what makes this feature work at all.
//
// It still forks in practice: a different device, a cleared profile, or an
// incognito window mints a fresh row. Production has three separate rows for
// Thomas himself. So we ALSO fold rows sharing a case-insensitive display name.
//
// KNOWN LIMITATION, observed in real data — do not mistake this for solved.
// `renameVisitor` overwrites `visitors.name` in place with no history, so the
// fold only sees whoever someone is called RIGHT NOW. Thomas's 2026-07-13 row
// (30e8b596) was "P-Thomas" during the conversation, was addressed as "Timtom",
// and is stored today as "Sean" — so it will NOT fold with the 47-session
// "P-Thomas" row from June. A durable cross-device identity needs either a
// claimed handle or a name-history table; both are out of scope here.
//
// The fold is also a heuristic in the other direction: two different people who
// both call themselves "Tom" get merged. That trade-off is acceptable for a
// personal portfolio town (a false merge costs a slightly-wrong pleasantry; a
// false split costs the product's core promise) but is NOT safe to carry into
// anything multi-tenant.
export async function identityIds(visitorId: string): Promise<string[]> {
  const [self] = await db
    .select({ id: visitors.id, name: visitors.name })
    .from(visitors)
    .where(eq(visitors.id, visitorId));
  if (!self) return [visitorId];
  const name = (self.name ?? "").trim();
  if (!name) return [self.id];
  const rows = await db
    .select({ id: visitors.id })
    .from(visitors)
    .where(sql`lower(trim(${visitors.name})) = lower(${name})`);
  const ids = new Set<string>([self.id, ...rows.map((r) => r.id)]);
  return [...ids];
}

/**
 * What this agent should know about this visitor on sight. `excludeSessionId` is
 * the live session, so an in-progress conversation never counts itself as prior
 * history ("you've talked once before" on the first message would be a lie).
 */
export async function historyFor(
  agentId: AgentId,
  visitorId: string,
  excludeSessionId?: string,
): Promise<VisitorHistory | null> {
  const aliasIds = await identityIds(visitorId);
  const [self] = await db
    .select({ name: visitors.name })
    .from(visitors)
    .where(eq(visitors.id, visitorId));
  if (!self) return null;

  // Only sessions where something was actually SAID count as a conversation —
  // an opened-and-abandoned panel isn't a memory, and production has several
  // zero-message session rows from smoke tests and mis-clicks.
  const rows = await db
    .selectDistinct({ id: chatSessions.id, startedAt: chatSessions.startedAt })
    .from(chatSessions)
    .innerJoin(chatMessages, eq(chatMessages.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.agentId, agentId),
        or(...aliasIds.map((id) => eq(chatSessions.visitorId, id))),
      ),
    )
    .orderBy(desc(chatSessions.startedAt));

  const prior = rows.filter((r) => r.id !== excludeSessionId);
  // Collapse to distinct days (see the priorSessions doc comment).
  const days = new Set(prior.map((r) => r.startedAt.toISOString().slice(0, 10)));
  return {
    visitorId,
    name: self.name ?? "a visitor",
    priorSessions: days.size,
    lastSeenAt: prior[0]?.startedAt ?? null,
    aliasIds,
  };
}

/** Batch form for the world delta, which may render several visitors at once. */
export async function historyForMany(
  agentId: AgentId,
  visitorIds: string[],
  excludeSessionId?: string,
): Promise<Map<string, VisitorHistory>> {
  const out = new Map<string, VisitorHistory>();
  await Promise.all(
    visitorIds.map(async (id) => {
      const h = await historyFor(agentId, id, excludeSessionId).catch(() => null);
      if (h) out.set(id, h);
    }),
  );
  return out;
}

/**
 * A compact transcript of a finished conversation, for writing into episodic
 * memory. Bounded so a long session can't blow up a Hindsight item.
 */
export async function transcriptDigest(sessionId: string, maxChars = 2_400): Promise<string | null> {
  const rows = await db
    .select({ sender: chatMessages.sender, body: chatMessages.body })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.ts);
  if (rows.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const who = r.sender === "visitor" ? "them" : "me";
    const line = `${who}: ${r.body.replace(/\s+/g, " ").trim()}`;
    if (used + line.length > maxChars) {
      lines.push("…(rest of the conversation not kept)");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** Human phrasing for how long ago a prior visit was. */
export function agoPhrase(then: Date, now = new Date()): string {
  const mins = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "about an hour ago" : `about ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `about ${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "about a month ago" : `about ${months} months ago`;
}
