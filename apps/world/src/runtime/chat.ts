// Visitor chat = a SESSION + SHARED TRANSCRIPT layer. The conversation itself
// still lives in each facet's continuous thread (loop.ts); a room session merely
// supplies canonical membership, routing, privacy, and one visible transcript.
// This module:
//   - creates/joins/leaves/ends a room (one visitor + at most two facets),
//   - persists the visible transcript (chat_messages) so a dropped panel can
//     rehydrate, fed by the loop's visitor turn (appendVisitorLine/appendAgentLine),
//   - sanitizes visitor input, validates the session token, pings + sweeps stale
//     sessions.

import { randomUUID } from "node:crypto";
import { eq, and, or, isNull, desc, asc } from "drizzle-orm";
import type { AgentId, GetChatResponse, LocationId, ShareCard } from "@town/contract";
import { db, schema } from "../db/client.js";
import { getAgent, moveAgent, setActivity, setStatus } from "../engine/agents.js";
import { isAdjacent } from "../engine/locations.js";
import { getVisitor } from "../engine/visitors.js";
import { appendEvent } from "../engine/events.js";
import { identityIds } from "../engine/visitor-history.js";
import { releaseAgentReservation, tryReserveAgent } from "./queue.js";
import { withRoomLock } from "./room-lock.js";

const { chatSessions, chatSessionParticipants, chatMessages } = schema;

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

export class ChatPresenceError extends Error {
  readonly reason = "not-co-located" as const;
}

export class ChatEngagedError extends Error {
  readonly reason = "engaged" as const;
}

export class ChatRoomFullError extends Error {
  readonly reason = "room-full" as const;
}

export function sameChatLocation(
  visitorLocation: string | null | undefined,
  agentLocation: string | null | undefined,
): boolean {
  return Boolean(visitorLocation && agentLocation && visitorLocation === agentLocation);
}

export async function chatParticipantsCoLocated(agentId: AgentId, visitorId: string): Promise<boolean> {
  const [agent, visitor] = await Promise.all([getAgent(agentId), getVisitor(visitorId)]);
  return sameChatLocation(visitor?.locationId, agent?.locationId);
}

export async function getActiveParticipants(sessionId: string): Promise<AgentId[]> {
  const rows = await db
    .select({ agentId: chatSessionParticipants.agentId })
    .from(chatSessionParticipants)
    .where(
      and(
        eq(chatSessionParticipants.sessionId, sessionId),
        isNull(chatSessionParticipants.leftAt),
      ),
    )
    .orderBy(asc(chatSessionParticipants.joinedAt));
  return rows.map((row) => row.agentId as AgentId);
}

export async function activeChatSessionForAgent(agentId: AgentId): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: chatSessionParticipants.sessionId })
    .from(chatSessionParticipants)
    .innerJoin(chatSessions, eq(chatSessions.id, chatSessionParticipants.sessionId))
    .where(
      and(
        eq(chatSessionParticipants.agentId, agentId),
        isNull(chatSessionParticipants.leftAt),
        isNull(chatSessions.endedAt),
      ),
    )
    .limit(1);
  return row?.sessionId ?? null;
}

export async function activeChatSessionForVisitor(visitorId: string): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.visitorId, visitorId), isNull(chatSessions.endedAt)))
    .limit(1);
  return row?.sessionId ?? null;
}

// Open a session: a routing record + initial canonical member. One visitor has
// one open room and one facet can occupy only one open room; partial unique
// indexes close cross-process races.
// Returns null if the agent or visitor does not exist.
export async function createSession(
  agentId: AgentId,
  visitorId: string,
): Promise<CreatedSession | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const visitor = await getVisitor(visitorId);
  if (!visitor) return null;
  if (!sameChatLocation(visitor.locationId, agent.locationId)) throw new ChatPresenceError();

  // Reconnect/reopen is idempotent when this facet is already in the visitor's
  // open room. A different facet must use joinSession explicitly.
  const [existing] = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.visitorId, visitorId),
        isNull(chatSessions.endedAt),
      ),
    )
    .orderBy(desc(chatSessions.startedAt))
    .limit(1);
  if (existing) {
    const participants = await getActiveParticipants(existing.id);
    if (!participants.includes(agentId)) throw new ChatEngagedError();
    const sessionToken = existing.sessionToken ?? randomUUID();
    if (!existing.sessionToken) {
      await db.update(chatSessions).set({ sessionToken }).where(eq(chatSessions.id, existing.id));
    }
    return {
      sessionId: existing.id,
      agentId,
      visitorId,
      participants,
      sessionToken,
    };
  }

  if (!tryReserveAgent(agentId)) throw new ChatEngagedError();
  const sessionId = randomUUID();
  const sessionToken = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(chatSessions).values({ id: sessionId, agentId, visitorId, sessionToken });
      await tx.insert(chatSessionParticipants).values({ sessionId, agentId });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ChatEngagedError();
    throw error;
  } finally {
    releaseAgentReservation(agentId);
  }
  // chat.started is PUBLIC presence only — no sessionId (chat content is the
  // agent's spoken replies, which surface as agent.spoke in the room).
  await appendEvent({
    type: "chat.started",
    agentId,
    visibility: "public",
    payload: { agent: agentId, visitorId },
  });
  await setStatus(agentId, "with a visitor");
  await setActivity(agentId, `talking with ${visitor.name}`);
  return { sessionId, agentId, visitorId, participants: [agentId], sessionToken };
}

export async function joinSession(
  sessionId: string,
  agentId: AgentId,
  opts: { allowAdjacent?: boolean } = {},
): Promise<AgentId[]> {
  const [session, agent] = await Promise.all([
    db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1),
    getAgent(agentId),
  ]);
  const current = session[0];
  if (!current || current.endedAt || !agent) throw new ChatEngagedError();
  const visitor = await getVisitor(current.visitorId);
  if (!visitor) throw new ChatPresenceError();
  let invitedTo: LocationId | undefined;
  if (!sameChatLocation(visitor.locationId, agent.locationId)) {
    const canWalkOver =
      opts.allowAdjacent &&
      visitor.locationId &&
      agent.locationId &&
      (await isAdjacent(agent.locationId as LocationId, visitor.locationId as LocationId));
    if (!canWalkOver) throw new ChatPresenceError();
    invitedTo = visitor.locationId as LocationId;
  }

  const already = await getActiveParticipants(sessionId);
  if (already.includes(agentId)) return already;
  // Do not let an invite turn a stale panel into a room spanning two physical
  // locations. The visitor must first return to the current room (or close it).
  for (const participant of already) {
    if (!(await chatParticipantsCoLocated(participant, current.visitorId))) {
      throw new ChatPresenceError();
    }
  }
  if (!tryReserveAgent(agentId)) throw new ChatEngagedError();
  let participants: AgentId[];
  try {
    participants = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ endedAt: chatSessions.endedAt })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .for("update");
      if (!locked || locked.endedAt) throw new ChatEngagedError();

      const active = await tx
        .select({ agentId: chatSessionParticipants.agentId })
        .from(chatSessionParticipants)
        .where(
          and(
            eq(chatSessionParticipants.sessionId, sessionId),
            isNull(chatSessionParticipants.leftAt),
          ),
        )
        .orderBy(asc(chatSessionParticipants.joinedAt));
      const participants = active.map((row) => row.agentId as AgentId);
      if (participants.includes(agentId)) return participants;
      if (participants.length >= 2) throw new ChatRoomFullError();

      const [historical] = await tx
        .select({ agentId: chatSessionParticipants.agentId })
        .from(chatSessionParticipants)
        .where(
          and(
            eq(chatSessionParticipants.sessionId, sessionId),
            eq(chatSessionParticipants.agentId, agentId),
          ),
        )
        .limit(1);
      // One row intentionally represents one contiguous visibility window. A
      // facet that chose to leave cannot be silently re-added to the same room;
      // allowing it would overwrite joinedAt/leftAt and break transcript privacy.
      if (historical) throw new ChatEngagedError();
      await tx.insert(chatSessionParticipants).values({ sessionId, agentId });
      return [...participants, agentId];
    });
  } catch (error) {
    releaseAgentReservation(agentId);
    if ((error as { code?: string }).code === "23505") throw new ChatEngagedError();
    throw error;
  }
  try {
    if (invitedTo) await moveAgent(agentId, invitedTo);
    await appendEvent({
      type: "chat.joined",
      agentId,
      visibility: "public",
      payload: { agent: agentId },
    });
    await setStatus(agentId, "with a visitor");
    await setActivity(agentId, `talking with ${visitor.name}`);
    return participants;
  } finally {
    releaseAgentReservation(agentId);
  }
}

// The session's agent + visitor (for routing a visitor message to the right
// thread). Null if the session is unknown or already ended.
export async function getSession(
  sessionId: string,
): Promise<{ agentId: AgentId; visitorId: string; participants: AgentId[] } | null> {
  const [s] = await db
    .select({ agentId: chatSessions.agentId, visitorId: chatSessions.visitorId, endedAt: chatSessions.endedAt })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!s || s.endedAt) return null;
  const participants = await getActiveParticipants(sessionId);
  if (participants.length === 0) return null;
  const primary = s.agentId as AgentId;
  return {
    agentId: participants.includes(primary) ? primary : participants[0],
    visitorId: s.visitorId,
    participants,
  };
}

// Called once per session when it actually closes, AFTER the chat.ended event.
// The loop registers a handler that writes the conversation into episodic memory
// (see loop.ts logVisitToEpisodicMemory); registered rather than imported so
// this module keeps no dependency on the loop — same seam as queue.ts's executor.
type SessionEndedHook = (args: {
  agentId: AgentId;
  visitorId: string;
  sessionId: string;
  until: Date;
}) => Promise<void>;

let onSessionEnded: SessionEndedHook | null = null;

export function registerSessionEndedHook(fn: SessionEndedHook): void {
  onSessionEnded = fn;
}

async function finalizeMember(args: {
  agentId: AgentId;
  visitorId: string;
  sessionId: string;
  until: Date;
  event: "chat.ended" | "chat.left";
}): Promise<void> {
  const { agentId, visitorId, sessionId, until, event } = args;
  await appendEvent({
    type: event,
    agentId,
    visibility: "public",
    payload: event === "chat.ended" ? { agent: agentId, visitorId } : { agent: agentId },
  });
  await setStatus(agentId, "awake").catch(() => undefined);
  await setActivity(
    agentId,
    event === "chat.ended"
      ? "wrapping up a visitor conversation"
      : "stepping away from a visitor conversation",
  ).catch(() => undefined);
  if (onSessionEnded) {
    await onSessionEnded({ agentId, visitorId, sessionId, until }).catch((err) =>
      console.warn(
        `[chat] membership-ended hook failed for ${sessionId}/${agentId}:`,
        (err as Error).message,
      ),
    );
  }
}

export async function endSession(sessionId: string): Promise<void> {
  const closedAt = new Date();
  // Atomically claim closure and vacate every active membership. leave_chat,
  // the sweep, pagehide, and an explicit close can race; only the winner emits.
  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .update(chatSessions)
      .set({ endedAt: closedAt })
      .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.endedAt)))
      .returning();
    if (!session) return null;
    const allMembers = await tx
      .select({ agentId: chatSessionParticipants.agentId, leftAt: chatSessionParticipants.leftAt })
      .from(chatSessionParticipants)
      .where(eq(chatSessionParticipants.sessionId, sessionId));
    await tx
      .update(chatSessionParticipants)
      .set({ leftAt: closedAt })
      .where(
        and(
          eq(chatSessionParticipants.sessionId, sessionId),
          isNull(chatSessionParticipants.leftAt),
        ),
      );
    return { session, allMembers };
  });
  if (!result) return;
  const { session, allMembers } = result;
  const activeMembers = allMembers.filter((member) => member.leftAt === null);
  for (const member of activeMembers) {
    const agentId = member.agentId as AgentId;
    await finalizeMember({
      agentId,
      visitorId: session.visitorId,
      sessionId,
      until: closedAt,
      event: "chat.ended",
    });
  }
}

// A facet can step out while the shared room remains alive. The final member's
// leave closes the session because a visitor-only room has no conversation.
export async function leaveSession(
  sessionId: string,
  agentId: AgentId,
): Promise<{ ended: boolean; participants: AgentId[] }> {
  const leftAt = new Date();
  const result = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ visitorId: chatSessions.visitorId, endedAt: chatSessions.endedAt })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .for("update");
    if (!session || session.endedAt) return { kind: "ended" as const };

    const active = await tx
      .select({ agentId: chatSessionParticipants.agentId })
      .from(chatSessionParticipants)
      .where(
        and(
          eq(chatSessionParticipants.sessionId, sessionId),
          isNull(chatSessionParticipants.leftAt),
        ),
      )
      .orderBy(asc(chatSessionParticipants.joinedAt));
    const participants = active.map((row) => row.agentId as AgentId);
    if (!participants.includes(agentId)) {
      return participants.length
        ? { kind: "unchanged" as const, participants }
        : { kind: "ended" as const };
    }

    if (participants.length === 1) {
      await tx
        .update(chatSessions)
        .set({ endedAt: leftAt })
        .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.endedAt)));
    }
    await tx
      .update(chatSessionParticipants)
      .set({ leftAt })
      .where(
        and(
          eq(chatSessionParticipants.sessionId, sessionId),
          eq(chatSessionParticipants.agentId, agentId),
          isNull(chatSessionParticipants.leftAt),
        ),
      );
    return {
      kind: participants.length === 1 ? "ended" as const : "left" as const,
      visitorId: session.visitorId,
      participants: participants.filter((id) => id !== agentId),
    };
  });

  if (result.kind === "unchanged") return { ended: false, participants: result.participants };
  if (result.kind === "ended" && !("visitorId" in result)) {
    return { ended: true, participants: [] };
  }
  if (!("visitorId" in result) || !result.visitorId || !result.participants) {
    return { ended: true, participants: [] };
  }
  await finalizeMember({
    agentId,
    visitorId: result.visitorId,
    sessionId,
    until: leftAt,
    event: result.kind === "ended" ? "chat.ended" : "chat.left",
  });
  return { ended: result.kind === "ended", participants: result.participants };
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
  for (const s of open) {
    await withRoomLock(s.id, async () => {
      // A slow response may have held this lane while the sweep waited. Read
      // its latest liveness signals now, not before acquiring the room lock.
      const [current] = await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, s.id), isNull(chatSessions.endedAt)));
      if (!current) return;
      const [lastMsg] = await db
        .select({ ts: chatMessages.ts })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, s.id))
        .orderBy(desc(chatMessages.ts))
        .limit(1);
      if (!isChatStale(
        { startedAt: current.startedAt, lastPingAt: current.lastPingAt, lastMessageAt: lastMsg?.ts ?? null },
        Date.now(),
        staleMs,
      )) return;
      console.log(`[chat] auto-closing stale session ${s.id} (agent ${s.agentId}).`);
      await endSession(s.id);
    });
  }
}

// Persist the visitor's line (the loop sanitizes before calling).
export async function appendVisitorLine(
  sessionId: string,
  text: string,
  responseRequestId: string,
): Promise<string> {
  const [row] = await db
    .insert(chatMessages)
    .values({ sessionId, sender: "visitor", body: text, responseRequestId })
    .returning({ id: chatMessages.id });
  return String(row.id);
}

export async function completeVisitorResponse(
  sessionId: string,
  responseRequestId: string,
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ responseCompletedAt: new Date() })
    .where(
      and(
        eq(chatMessages.sessionId, sessionId),
        eq(chatMessages.responseRequestId, responseRequestId),
      ),
    );
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

export async function lastActiveAgentSpeaker(
  sessionId: string,
  participants: AgentId[],
): Promise<AgentId | undefined> {
  const rows = await db
    .select({ sender: chatMessages.sender })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.id))
    .limit(20);
  return rows
    .map((row) => row.sender as AgentId)
    .find((sender) => participants.includes(sender));
}

// GET /chats/:id payload: canonical active roster + shared visible transcript.
// The legacy "agent" sentinel maps to the opening facet. Historical operator
// rows remain private model context and are never exposed.
export async function getChatTranscript(sessionId: string): Promise<GetChatResponse | null> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return null;
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.id));
  const primary = session.agentId as AgentId;
  const participantRows = await db
    .select({ agentId: chatSessionParticipants.agentId, leftAt: chatSessionParticipants.leftAt })
    .from(chatSessionParticipants)
    .where(eq(chatSessionParticipants.sessionId, sessionId))
    .orderBy(asc(chatSessionParticipants.joinedAt));
  const active = participantRows
    .filter((row) => row.leftAt === null)
    .map((row) => row.agentId as AgentId);
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
  const responses = rows
    .filter((row) => row.sender === "visitor" && row.responseRequestId)
    .map((row) => ({
      requestId: row.responseRequestId!,
      completed: row.responseCompletedAt !== null,
    }));
  return {
    sessionId: session.id,
    visitorId: session.visitorId,
    participants: active,
    endedAt: session.endedAt?.toISOString() ?? null,
    messages,
    responses,
  };
}

// --- prior conversation (visible continuity) ---------------------------------
// The agents were taught to remember visitors (engine/visitor-history.ts + the
// episodic visit log), but the PANEL still forgot: a session's transcript is
// reachable only with that session's in-memory token, so a reload — or simply
// switching facets and coming back — showed a blank slate. The facet would open
// with "you've talked 9 times before" above an empty transcript, which reads as
// broken rather than warm.
//
// This returns recent shared-room messages from sessions in which this facet
// participated, so the panel can show "here's where you left off". Identity is
// folded with identityIds() — the same heuristic the acquaintance line uses — so
// a visitor whose row forked across devices still sees their own history.
export async function priorConversationWith(
  agentId: AgentId,
  visitorId: string,
  opts: { excludeSessionId?: string; limit?: number } = {},
): Promise<{ messages: GetChatResponse["messages"]; lastAt: string | null }> {
  const limit = opts.limit ?? 20;
  const aliasIds = await identityIds(visitorId);

  const rows = await db
    .select({
      id: chatMessages.id,
      sender: chatMessages.sender,
      body: chatMessages.body,
      ts: chatMessages.ts,
      attachments: chatMessages.attachments,
      sessionId: chatSessions.id,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .innerJoin(
      chatSessionParticipants,
      and(
        eq(chatSessionParticipants.sessionId, chatSessions.id),
        eq(chatSessionParticipants.agentId, agentId),
      ),
    )
    .where(
      and(
        or(...aliasIds.map((id) => eq(chatSessions.visitorId, id))),
      ),
    )
    // Newest-first so the LIMIT keeps the most recent exchange, then flipped
    // below — taking the oldest N would show the wrong end of a long history.
    .orderBy(desc(chatMessages.id))
    .limit(limit + 40);

  const messages = rows
    .filter((r) => r.sessionId !== opts.excludeSessionId && r.sender !== "operator")
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      id: String(r.id),
      sender: (r.sender === "visitor"
        ? "visitor"
        : r.sender === "agent"
          ? agentId
          : r.sender) as "visitor" | AgentId,
      body: r.body,
      ts: r.ts.toISOString(),
      attachments: (r.attachments ?? []) as ShareCard[],
    }));

  return {
    messages,
    lastAt: messages.length ? messages[messages.length - 1].ts : null,
  };
}
