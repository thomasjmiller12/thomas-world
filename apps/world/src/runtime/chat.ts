// Visitor chat (plan §4.1 "visitor chat = interrupt"). Marks the agent busy
// (idle ticks skip it), opens a chat session on the chat model (Opus 4.8), and
// streams the response token-by-token to the browser via the SDK stream
// helpers — never hand-rolled event plumbing. On close, the agent's next tick
// perceives the conversation in its observation.
//
// Mid-conversation system messages are Opus-gated (plan §4.3): on Opus we may
// inject operator context as a role:"system" message; the Haiku fallback (a
// <system-reminder> text block in the user turn) is implemented in
// systemReminderTurn() for completeness, used if a chat ever runs on Haiku.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { eq, isNull, desc, asc } from "drizzle-orm";
import type { AgentId, LocationId, ChatStreamFrame, WorldEvent, GetChatResponse } from "@town/contract";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { db, schema } from "../db/client.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS, MID_CONV_SYSTEM_BETA } from "./client.js";
import { getProfile } from "./roles.js";
import { buildChatTools, type AgentContext } from "./tools.js";
import { getAgent, setEngagement, clearEngagement } from "../engine/agents.js";
import { appendEvent, recentEventsForAgent } from "../engine/events.js";
import { getVisitor } from "../engine/visitors.js";
import { tryAcquire } from "./agent-lock.js";

const { chatSessions, chatMessages } = schema;

// Strip anything that looks like an injected instruction from visitor input
// before it reaches the model as plain user text (anti prompt-injection, plan
// §4.1 "sanitize visitor-chat content"). We don't rewrite meaning — we just
// neutralize the most common override scaffolding so it can't masquerade as an
// operator instruction, and we hard-cap length.
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

// openChat outcomes (design doc §3.2/§3.4):
//   - ok        → session opened; carries the id, token and participants
//   - unknown   → no such agent (HTTP 404)
//   - engaged   → agent is in a live chat/scene (HTTP 409, in-fiction alternatives)
//   - mid-thought → the agent-lock was held this instant (a tick is mid-flight);
//                   distinct from `engaged` so the HTTP layer can render
//                   "mid-thought, try in a moment" rather than the engaged copy.
export type OpenChatResult =
  | {
      status: "ok";
      sessionId: string;
      agentId: AgentId;
      visitorId: string;
      participants: AgentId[];
      sessionToken: string;
    }
  | { status: "unknown" }
  | { status: "engaged"; engagement: { kind: "chat" | "scene"; with: (AgentId | "visitor")[] } }
  | { status: "mid-thought" };

// Open a chat session: take the agent-lock for the instant, set engagement,
// persist the session row + token, emit chat.started, release the lock. The
// lock guards the instant (no in-flight tick); engagement guards the session.
export async function openChat(agentId: AgentId, visitorId: string): Promise<OpenChatResult> {
  const agent = await getAgent(agentId);
  if (!agent) return { status: "unknown" };
  // Already in a chat/scene → in-fiction 409 with actionable alternatives.
  if (agent.engagement) {
    const eng = agent.engagement;
    const withList: (AgentId | "visitor")[] = [...eng.participants];
    if (eng.kind === "chat") withList.push("visitor");
    return { status: "engaged", engagement: { kind: eng.kind, with: withList } };
  }
  // Lock held → a tick is mid-flight for this agent. Engagement alone doesn't
  // serialize against an in-process tick, so acquire the lock before setting it.
  const release = tryAcquire(agentId);
  if (!release) return { status: "mid-thought" };
  try {
    const sessionId = randomUUID();
    const sessionToken = randomUUID();
    await db.insert(chatSessions).values({ id: sessionId, agentId, visitorId, sessionToken });
    await setEngagement("chat", sessionId, [agentId]);
    // chat.started is PUBLIC presence only — NO sessionId (design doc §3.3:
    // visitor↔agent chat content is private; the public event carries presence).
    await appendEvent({
      type: "chat.started",
      agentId,
      visibility: "public",
      payload: { agent: agentId, visitorId },
    });
    return {
      status: "ok",
      sessionId,
      agentId,
      visitorId,
      participants: [agentId],
      sessionToken,
    };
  } finally {
    // Release after engagement is set: the lock guarded the instant; engagement
    // now guards the session for its lifetime.
    release();
  }
}

export async function endChat(sessionId: string): Promise<void> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return;
  await db.update(chatSessions).set({ endedAt: new Date() }).where(eq(chatSessions.id, sessionId));
  // clearEngagement releases every participant of this session (a group chat
  // has two agents engaged under the same id) — the single owner of clearing.
  await clearEngagement("chat", sessionId);
  await appendEvent({
    type: "chat.ended",
    agentId: session.agentId as AgentId,
    visibility: "public",
    payload: { agent: session.agentId, visitorId: session.visitorId, sessionId },
  });
}

// Token check for the auth-gated chat endpoints (/open, /messages, /close,
// /ping). Returns true iff the session exists and the token matches. A session
// created before this migration (null token) cannot be authorized — callers
// treat a mismatch as 401.
export async function chatTokenValid(sessionId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [s] = await db
    .select({ token: chatSessions.sessionToken })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  return Boolean(s && s.token && s.token === token);
}

// Liveness ping (design doc §3.4): WorldClient pings every 60s while the panel
// is open. Records the ping so the sweep keeps a slow-typing / long-reading
// visitor's session alive even with no new messages.
export async function pingChat(sessionId: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ lastPingAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

// Pure liveness predicate (design doc §3.4): a session is stale iff its last
// SIGNAL — the latest of last ping, last message, and session start — is older
// than `staleMs`. So a session stays alive as long as EITHER pings OR messages
// keep arriving; only when BOTH go quiet for `staleMs` does it close. Pure so
// the liveness rule is unit-testable without a DB.
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

// Auto-close chat sessions abandoned without a /chats/:id/close call (the common
// case: the visitor closes the tab, loses network, or the browser never fires
// the close). Each such session leaves the agent engaged forever, so the
// scheduler permanently skips it. Liveness-aware (design doc §3.4): close only
// sessions with NO ping AND no message for `staleMs` (default 3 min) — the 60s
// pings from an open panel keep a slow visitor's session alive; an abandoned tab
// frees the agent in ≤ staleMs. endChat clears engagement for every participant.
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
      await endChat(s.id);
    }
  }
}

// One persisted chat row, as far as history rendering cares.
export interface ChatRowLike {
  sender: string; // "visitor" | "agent" | "operator" | (future) AgentId
  body: string;
  ts: Date;
}

// Pure row→message mapper (design doc §3.4). The agent's own lines render as
// `assistant`; everything else — visitor input AND `operator` rows (synthetic
// opener / mid-chat notes) — folds into `user` turns. Because the byte-stable
// operator opener persists FIRST, the leading turn is always a `user` turn, so
// the API history NEVER starts with an `assistant` message (the 400-trap).
// Pure + synchronous so the "assistant never first" invariant is unit-testable.
export function rowsToHistory(rows: ChatRowLike[]): Anthropic.Beta.BetaMessageParam[] {
  const sorted = [...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return sorted.map((r) => ({
    role: r.sender === "agent" ? ("assistant" as const) : ("user" as const),
    content: r.body,
  }));
}

// Build the running message history for a chat session from chat_messages —
// including operator rows (hidden from the visible transcript, fed to the model
// as leading/context `user` turns).
async function historyFor(sessionId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));
  return rowsToHistory(rows);
}

// The Haiku fallback for mid-conversation operator context (plan §4.3): inject
// it as a <system-reminder> text block inside the user turn instead of a
// role:"system" message (which Haiku rejects with a 400).
function systemReminderTurn(text: string): Anthropic.Beta.BetaMessageParam {
  return { role: "user", content: `<system-reminder>${text}</system-reminder>` };
}

export interface ChatTurnHandlers {
  // Emits one contract ChatStreamFrame. The HTTP layer serializes it as the SSE
  // `data` payload (the `type` field is the discriminator — no SSE event names).
  onFrame: (frame: ChatStreamFrame) => void | Promise<void>;
}

// Memory tool names that, when invoked mid-turn, justify a `memory_recalled`
// annotation (design doc §5). `recall` is episodic (Hindsight); `memory` is the
// SDK core-memory tool — a `view` on it is the recall signal.
const RECALL_TOOLS = new Set(["recall", "memory"]);

// Map a memory tool-use to a human recency label. We don't have per-result
// timing here, so we label by source: episodic recall reads across days, the
// core-memory view is always-loaded context.
function recallLabel(toolName: string): string {
  return toolName === "recall" ? "recalled from earlier" : "drew on a memory";
}

// Run one visitor turn: append the (sanitized) visitor message, stream the
// agent's reply as contract frames, persist the turn, emit a `done` frame
// carrying the REAL persisted messageId. `operatorNote` is optional, internal
// mid-conversation context injected per the model gate (never client-supplied).
export async function runChatTurn(
  sessionId: string,
  visitorText: string,
  handlers: ChatTurnHandlers,
  operatorNote?: string,
): Promise<{ text: string; ok: boolean }> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return { text: "", ok: false };
  const agentId = session.agentId as AgentId;

  if (!hasLlm()) {
    const text = "The town's a little quiet right now — the agents can't chat yet.";
    await handlers.onFrame({ type: "turn_started", agent: agentId });
    await handlers.onFrame({ type: "text", text, agent: agentId });
    const id = await persistAgentTurn(sessionId, text);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { text, ok: false };
  }
  const profile = getProfile(agentId);
  const isOpus = profile.role.chatModel.startsWith("claude-opus");

  const clean = sanitizeVisitorText(visitorText);
  await db.insert(chatMessages).values({ sessionId, sender: "visitor", body: clean });

  const history = await historyFor(sessionId);
  // history already includes the just-inserted visitor turn.
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history];
  const betas: string[] = [...TICK_BETAS];
  if (operatorNote) {
    if (isOpus) {
      // Opus: append a role:"system" mid-conversation message (preserves cache).
      betas.push(MID_CONV_SYSTEM_BETA);
      messages.push({
        role: "system",
        content: operatorNote,
      } as Anthropic.Beta.BetaMessageParam);
    } else {
      // Haiku fallback: <system-reminder> inside a user turn.
      messages.push(systemReminderTurn(operatorNote));
    }
  }

  const agent = await getAgent(agentId);
  const ctx: AgentContext = {
    agentId,
    location: (agent?.locationId as LocationId) ?? "town",
    conversationId: null,
  };
  const tools = buildChatTools(ctx);

  let full = "";
  let recalledThisTurn = false;
  await handlers.onFrame({ type: "turn_started", agent: agentId });
  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: profile.role.chatModel,
      max_tokens: 2048,
      system: systemBlocks(agentId),
      messages,
      tools,
      max_iterations: 4,
      stream: true,
      betas,
    });

    for await (const stream of runner) {
      stream.on("text", (delta) => {
        full += delta;
        void handlers.onFrame({ type: "text", text: delta, agent: agentId });
      });
      const message = await stream.finalMessage();
      // memory_recalled: emit when a recall/memory tool ACTUALLY ran this turn
      // (hooked at the toolRunner iteration — design doc §5). Once per turn so
      // it's a restrained marker, never a counter.
      if (!recalledThisTurn) {
        for (const block of message.content) {
          if (block.type === "tool_use" && RECALL_TOOLS.has(block.name)) {
            recalledThisTurn = true;
            await handlers.onFrame({
              type: "memory_recalled",
              label: recallLabel(block.name),
              agent: agentId,
            });
            break;
          }
        }
      }
      if (message.stop_reason === "refusal") {
        const note = "\n(— the agent declined to continue down that path.)";
        await handlers.onFrame({ type: "text", text: note, agent: agentId });
        full += note;
        break;
      }
    }
  } catch (err) {
    console.warn(`[chat ${sessionId}] error:`, (err as Error).message);
    const note = "Sorry — something glitched on our end.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await persistAgentTurn(sessionId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { text: note, ok: false };
  }

  const text = full.trim();
  const messageId = await persistAgentTurn(sessionId, text);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });
  return { text, ok: true };
}

// Persist the agent's turn and return the REAL row id (captured via .returning())
// so the `done` frame carries the persisted messageId the contract requires.
// An empty turn isn't stored; we still need a stable id for the frame, so a
// sentinel is returned (the client only uses it to dedupe a rendered bubble).
async function persistAgentTurn(sessionId: string, text: string): Promise<string> {
  if (!text) return "empty";
  const [row] = await db
    .insert(chatMessages)
    .values({ sessionId, sender: "agent", body: text })
    .returning({ id: chatMessages.id });
  return String(row.id);
}

// --- agent-first greeting (design doc §3.4) --------------------------------

// Render an agent's recent event into a terse "what I was just doing" line for
// the greeting opener. Pure + byte-stable (no timestamps) so the opener row is
// cache-friendly and identical across re-renders of the same session.
function recentEventLine(e: WorldEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "agent.activity":
      return `you set your activity to "${p.activity}"`;
    case "agent.thought":
      return p.text ? `you thought: "${p.text}"` : null;
    case "agent.spoke":
      return p.text ? `you said: "${p.text}"` : null;
    case "agent.moved":
      return `you walked to the ${p.to}`;
    case "artifact.created":
      return `you made a ${p.kind}: "${p.title}"`;
    case "artifact.updated":
      return `you updated "${p.title}"`;
    case "bulletin.posted":
      return `you posted a bulletin: "${p.title}"`;
    case "conversation.turn":
      return p.text ? `you were mid-conversation: "${p.text}"` : null;
    default:
      return null;
  }
}

// Build the synthetic opener prompt fed to the agent as a leading operator row
// (design doc §3.4). Pure + byte-stable for a given (agent, activity, events,
// visitorName) so it caches and never drifts across re-reads. The agent reads
// this as an operator note instructing it to greet the visitor in character,
// leading with what it was just doing — that's the "continuity is the product"
// stance (§0): the agent greets YOU with what it was up to.
export function buildGreetingOpener(args: {
  displayName: string;
  activity: string | null;
  recentEvents: WorldEvent[];
  visitorName: string | null;
}): string {
  const { displayName, activity, recentEvents, visitorName } = args;
  const lines = recentEvents
    .map(recentEventLine)
    .filter((l): l is string => l !== null)
    .slice(-3);
  const visitor = visitorName ? `${visitorName}` : "a visitor";
  const parts: string[] = [
    `[operator note] ${visitor} just walked up to you and you've noticed them.`,
    activity ? `You were in the middle of: ${activity}.` : `You were between things.`,
  ];
  if (lines.length) {
    parts.push(`Recently: ${lines.join("; ")}.`);
  }
  parts.push(
    `Greet them now, in character as ${displayName} — warm and genuine, leading with what you were just doing so they feel they walked into a life already in motion. One or two sentences. Don't ask how you can help; you're a person, not a service desk.`,
  );
  return parts.join(" ");
}

// openGreeting outcomes:
//   - ok        → streamed the agent's greeting turn
//   - unknown   → no such session (HTTP 404; the HTTP layer gates on the token first)
//   - already   → the session already has messages (HTTP 409, idempotent-ish guard)
export type OpenGreetingResult =
  | { status: "ok"; text: string }
  | { status: "unknown" }
  | { status: "already" };

// Stream the agent-initiated greeting (design doc §3.4). Mechanics, EXACTLY:
//  1. Persist a `sender:'operator'` row FIRST holding the byte-stable opener —
//     hidden from the visible transcript, rendered by historyFor as the leading
//     `user` turn so the greeting (an assistant row) never sits first.
//  2. Stream the agent's reply as contract frames; persist it as the agent's
//     message and emit a `done` with the real messageId.
// Idempotent-ish: a second call on a session that already has ANY messages
// returns `already` (the HTTP layer maps it to 409) — never a double greeting.
export async function openGreeting(
  sessionId: string,
  handlers: ChatTurnHandlers,
): Promise<OpenGreetingResult> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return { status: "unknown" };
  // Idempotency: if anything's been said in this session, /open already ran (or
  // a message was sent) — don't greet again.
  const existing = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .limit(1);
  if (existing.length) return { status: "already" };

  const agentId = session.agentId as AgentId;
  const agent = await getAgent(agentId);
  const [recent, visitor] = await Promise.all([
    recentEventsForAgent(agentId, 3),
    getVisitor(session.visitorId).catch(() => undefined),
  ]);
  const opener = buildGreetingOpener({
    displayName: agent?.displayName ?? agentId,
    activity: agent?.activity ?? null,
    recentEvents: recent,
    visitorName: visitor?.name ?? null,
  });
  // Persist the operator opener FIRST so it leads the API history as a user turn.
  await db.insert(chatMessages).values({ sessionId, sender: "operator", body: opener });

  await handlers.onFrame({ type: "turn_started", agent: agentId });

  if (!hasLlm()) {
    const text = "Oh — hey. Didn't see you walk in. Give me a sec, the town's a little quiet right now.";
    await handlers.onFrame({ type: "text", text, agent: agentId });
    const id = await persistAgentTurn(sessionId, text);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { status: "ok", text };
  }

  const profile = getProfile(agentId);
  const ctx: AgentContext = {
    agentId,
    location: (agent?.locationId as LocationId) ?? "town",
    conversationId: null,
  };
  const tools = buildChatTools(ctx);
  // historyFor includes the just-inserted operator row as the leading user turn.
  const messages = await historyFor(sessionId);

  let full = "";
  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: profile.role.chatModel,
      max_tokens: 1024,
      system: systemBlocks(agentId),
      messages,
      tools,
      max_iterations: 3,
      stream: true,
      betas: [...TICK_BETAS],
    });
    for await (const stream of runner) {
      stream.on("text", (delta) => {
        full += delta;
        void handlers.onFrame({ type: "text", text: delta, agent: agentId });
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") break;
    }
  } catch (err) {
    console.warn(`[chat ${sessionId}] greeting error:`, (err as Error).message);
    const note = "Oh — hi there. Come on in.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await persistAgentTurn(sessionId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { status: "ok", text: note };
  }

  const text = full.trim() || "Oh — hi there. Come on in.";
  const messageId = await persistAgentTurn(sessionId, text);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });
  return { status: "ok", text };
}

// Whether a session has ANY persisted message row — including the hidden
// `operator` opener. The /open idempotency guard uses this (NOT the visible
// transcript): once the operator opener is written, /open has run, so a second
// call must 409 even before the agent's visible reply lands.
export async function chatHasAnyMessage(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .limit(1);
  return Boolean(row);
}

// --- transcript recovery (design doc §3.4, §5) ------------------------------

// GET /chats/:id payload: the session + the VISIBLE transcript (design doc §5).
// Operator rows are NEVER exposed (they're model context only) — only visitor
// and agent lines surface. Used to rehydrate a panel after a dropped stream.
export async function getChatTranscript(sessionId: string): Promise<GetChatResponse | null> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return null;
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.id));
  const participants: AgentId[] = [session.agentId as AgentId];
  const messages = rows
    .filter((r) => r.sender !== "operator")
    .map((r) => ({
      id: String(r.id),
      // sender is "visitor" or an AgentId (operator already filtered out).
      sender: (r.sender === "visitor" ? "visitor" : (r.sender as AgentId)) as
        | "visitor"
        | AgentId,
      body: r.body,
      ts: r.ts.toISOString(),
    }));
  return {
    sessionId: session.id,
    visitorId: session.visitorId,
    participants,
    messages,
  };
}

// Post-turn suggested replies (design doc §5): a cheap Haiku call that NEVER
// blocks `done` — the HTTP layer fires it after the done frame. Uses the SDK's
// structured-output parse when available, falling back to JSON extraction from a
// plain call; any failure yields no chips (the feature is best-effort).
const SuggestedReplies = z.object({
  replies: z.array(z.string()).max(3),
});

export async function suggestedReplies(sessionId: string): Promise<string[]> {
  if (!hasLlm()) return [];
  try {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const recent = rows.slice(-6);
    if (recent.length === 0) return [];
    const transcript = recent
      .map((r) => `${r.sender === "visitor" ? "Visitor" : "Agent"}: ${r.body}`)
      .join("\n");
    const prompt = [
      "Given this short conversation between a visitor and a town character,",
      "suggest up to 3 brief, natural replies the VISITOR might tap next.",
      "Each ≤ 8 words. Return only the replies.",
      "",
      transcript,
    ].join("\n");

    // Preferred: structured output via messages.parse + betaZodOutputFormat.
    try {
      const parsed = await anthropic.beta.messages.parse({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: betaZodOutputFormat(SuggestedReplies) },
      });
      const out = parsed.parsed_output;
      if (out?.replies) return out.replies.slice(0, 3);
    } catch {
      // Fall through to a plain call + JSON extraction below.
    }

    const res = await anthropic.beta.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\nReturn a JSON object: {"replies": ["...", "..."]}`,
        },
      ],
    });
    const raw = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const obj = JSON.parse(match[0]);
    const parsed = SuggestedReplies.safeParse(obj);
    return parsed.success ? parsed.data.replies.slice(0, 3) : [];
  } catch (err) {
    console.warn(`[chat ${sessionId}] suggested_replies failed:`, (err as Error).message);
    return [];
  }
}
