// Visitor chat = a thin SESSION + TRANSCRIPT layer (M3). The conversation itself
// no longer has its own LLM context: a visitor's message is an interrupt INPUT to
// the agent's continuous thread (loop.ts runVisitorInput), and the agent's reply
// is plain text it SPEAKS. This module only:
//   - creates/ends a session (a routing record: which visitor ↔ which agent, + a
//     per-session token) and emits chat.started / chat.ended presence events,
//   - persists the visible transcript (chat_messages) so a dropped panel can
//     rehydrate, fed by the loop's visitor turn (appendVisitorLine/appendAgentLine),
//   - sanitizes visitor input, validates the session token, pings + sweeps stale
//     sessions.
//
// Gone with M3: openChat's framing/engagement/LLM, runChatTurn, the director +
// interject, group-chat perspectives, and the operator-note routing for fixture/
// movement — the agent perceives those through its world delta now, not a stashed
// note. The frontend is unchanged (same /chats endpoints + ChatStreamFrame).

import { randomUUID } from "node:crypto";
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import type { AgentId, GetChatResponse, ShareCard } from "@town/contract";
import { db, schema } from "../db/client.js";
import { getAgent } from "../engine/agents.js";
import { appendEvent } from "../engine/events.js";

const { chatSessions, chatMessages } = schema;

// Strip anything that looks like an injected instruction from visitor input
// before it reaches the model as plain user text (anti prompt-injection). We
// don't rewrite meaning — we neutralize the most common override scaffolding so
// it can't masquerade as an operator instruction, and we hard-cap length.
export function sanitizeVisitorText(raw: string): string {
  return raw
    .replace(/<\s*\/?\s*system[-_]?reminder\s*>/gi, "")
    .replace(
      /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous\s+|prior\s+|earlier\s+|above\s+)?(?:instructions|guidelines|rules|prompts?)\b/gi,
      "[redacted]",
    )
    .slice(0, 4_000)
    .trim();
}

export interface CreatedSession {
  sessionId: string;
  agentId: AgentId;
  visitorId: string;
  participants: AgentId[];
  sessionToken: string;
}

// Open a session: a routing record + token. In M3 there is no "engaged" / "mid-
// thought" gate — a visitor can always start; their message becomes an interrupt
// input the agent handles on its next turn (queue-serialized). Returns null if
// the agent doesn't exist.
export async function createSession(
  agentId: AgentId,
  visitorId: string,
): Promise<CreatedSession | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const sessionId = randomUUID();
  const sessionToken = randomUUID();
  await db
    .insert(chatSessions)
    .values({ id: sessionId, agentId, participantAgentIds: [agentId], visitorId, sessionToken });
  // chat.started is PUBLIC presence only — no sessionId (chat content is the
  // agent's spoken replies, which surface as agent.spoke in the room).
  await appendEvent({
    type: "chat.started",
    agentId,
    visibility: "public",
    payload: { agent: agentId, visitorId },
  });
  return { sessionId, agentId, visitorId, participants: [agentId], sessionToken };
}

// The session's agent + visitor (for routing a visitor message to the right
// thread). Null if the session is unknown or already ended.
export async function getSession(
  sessionId: string,
): Promise<{ agentId: AgentId; visitorId: string } | null> {
  const [s] = await db
    .select({ agentId: chatSessions.agentId, visitorId: chatSessions.visitorId, endedAt: chatSessions.endedAt })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!s || s.endedAt) return null;
  return { agentId: s.agentId as AgentId, visitorId: s.visitorId };
}

export async function endSession(sessionId: string): Promise<void> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return;
  // Idempotency: leave_chat, the sweep, and POST /chats/:id/close can race.
  if (session.endedAt) return;
  await db.update(chatSessions).set({ endedAt: new Date() }).where(eq(chatSessions.id, sessionId));
  await appendEvent({
    type: "chat.ended",
    agentId: session.agentId as AgentId,
    visibility: "public",
    payload: { agent: session.agentId, visitorId: session.visitorId },
  });
}

// Token check for the auth-gated chat endpoints. True iff the session exists and
// the token matches.
export async function chatTokenValid(sessionId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [s] = await db
    .select({ token: chatSessions.sessionToken })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  return Boolean(s && s.token && s.token === token);
}

// Liveness ping (WorldClient pings every 60s while the panel is open).
export async function pingChat(sessionId: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ lastPingAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

// Pure liveness predicate: a session is stale iff its last SIGNAL — the latest of
// last ping, last message, and session start — is older than `staleMs`. Pure so
// the rule is unit-testable without a DB.
export function isChatStale(
  args: { startedAt: Date; lastPingAt: Date | null; lastMessageAt: Date | null },
  now: number,
  staleMs: number,
): boolean {
  const lastSignal = Math.max(
    args.startedAt.getTime(),
    args.lastPingAt?.getTime() ?? 0,
    args.lastMessageAt?.getTime() ?? 0,
  );
  return now - lastSignal >= staleMs;
}

// Auto-close sessions abandoned without a /chats/:id/close call. Liveness-aware:
// close only sessions with NO ping AND no message for `staleMs` (default 3 min).
export async function sweepStaleChats(staleMs = 3 * 60_000): Promise<void> {
  const open = await db.select().from(chatSessions).where(isNull(chatSessions.endedAt));
  const now = Date.now();
  for (const s of open) {
    const [lastMsg] = await db
      .select({ ts: chatMessages.ts })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, s.id))
      .orderBy(desc(chatMessages.ts))
      .limit(1);
    const stale = isChatStale(
      { startedAt: s.startedAt, lastPingAt: s.lastPingAt, lastMessageAt: lastMsg?.ts ?? null },
      now,
      staleMs,
    );
    if (stale) {
      console.log(`[chat] auto-closing stale session ${s.id} (agent ${s.agentId}).`);
      await endSession(s.id);
    }
  }
}

// Persist the visitor's line (the loop sanitizes before calling).
export async function appendVisitorLine(sessionId: string, text: string): Promise<void> {
  await db.insert(chatMessages).values({ sessionId, sender: "visitor", body: text });
}

// Persist the agent's spoken reply and return the REAL row id (for the `done`
// frame's messageId). An empty reply isn't stored; a sentinel id is returned.
export async function appendAgentLine(
  sessionId: string,
  agentId: AgentId,
  text: string,
  attachments: ShareCard[] = [],
): Promise<string> {
  if (!text) return "empty";
  const [row] = await db
    .insert(chatMessages)
    .values({ sessionId, sender: agentId, body: text, attachments })
    .returning({ id: chatMessages.id });
  return String(row.id);
}

// How many visitor turns a session has seen (session cap). Counts visitor rows.
export async function visitorTurnCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.sender, "visitor")));
  return rows.length;
}

// GET /chats/:id payload: the session + VISIBLE transcript (for panel recovery).
// One agent per session in M3; the legacy "agent" sentinel maps to it. Any
// historical "operator" rows are filtered out.
export async function getChatTranscript(sessionId: string): Promise<GetChatResponse | null> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return null;
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.id));
  const primary = session.agentId as AgentId;
  const messages = rows
    .filter((r) => r.sender !== "operator")
    .map((r) => ({
      id: String(r.id),
      sender: (r.sender === "visitor"
        ? "visitor"
        : r.sender === "agent"
          ? primary
          : (r.sender as AgentId)) as "visitor" | AgentId,
      body: r.body,
      ts: r.ts.toISOString(),
      attachments: (r.attachments ?? []) as ShareCard[],
    }));
  return {
    sessionId: session.id,
    visitorId: session.visitorId,
    participants: [primary],
    messages,
  };
}
