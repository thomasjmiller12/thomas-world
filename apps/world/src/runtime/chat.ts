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
import { eq, and, isNull, desc, asc } from "drizzle-orm";
import { agentIds } from "@town/contract";
import type { AgentId, LocationId, ChatStreamFrame, GetChatResponse } from "@town/contract";
import { z } from "zod";
import { db, schema } from "../db/client.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS, MID_CONV_SYSTEM_BETA } from "./client.js";
import { getProfile } from "./roles.js";
import { buildChatTools, type AgentContext } from "./tools.js";
import { getAgent, setEngagement, clearEngagement } from "../engine/agents.js";
import { getVisitor } from "../engine/visitors.js";
import { getLocation } from "../engine/locations.js";
import { recentEventsForAgent } from "../engine/events.js";
import { renderLine } from "../engine/feed.js";

// Which of an agent's recent events are "things it DID" worth reminding it of
// mid-chat (vs. ambient movement noise).
const OWN_DOING_TYPES = new Set<string>([
  "artifact.created",
  "artifact.updated",
  "bulletin.posted",
  "message.sent",
  "agent.spoke",
  "capability.requested",
]);
function isOwnDoing(e: { type: string }): boolean {
  return OWN_DOING_TYPES.has(e.type);
}
import { appendEvent } from "../engine/events.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { tryAcquire } from "./agent-lock.js";

// The model suggestedReplies runs on (cheap post-turn chips, design doc §5).
// Literal so the usage row records the model actually billed.

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

// The channel-framing operator row inserted at session creation (M2.1). NOT a
// greeting — the agent doesn't speak first — but the model needs to know it has
// left tick-land: in a tick, plain text is private scratch; in a chat, the
// streamed text IS the spoken reply. Without this row agents narrate their inner
// monologue to the visitor and reach for `say` to actually answer (observed in
// the wild on day one). Byte-stable for the session (cache-friendly: it heads
// the transcript under the message cache breakpoint) and rendered by
// rowsToHistory as the leading user turn, so the no-leading-assistant invariant
// holds. Hidden from the visible transcript like every operator row.
export function buildChatFraming(
  visitorName: string | null,
  grounding?: {
    locationName?: string | null;
    activity?: string | null;
    // Short third-person lines of the agent's own recent actions ("posted a
    // bulletin: …"). Without these an agent has NO window onto its own recent
    // ticks mid-chat (observed: Career denied knowing about a bulletin he
    // posted an hour earlier) — episodic memory only catches up at reflection.
    recentDoings?: string[];
  },
): string {
  const who = visitorName ? `A visitor (${visitorName})` : "A visitor";
  // Ground the chat in the agent's LIVE position/activity. Without this the
  // model free-associates its home location from the soul file ("here in the
  // office" while standing in the cafe — the deferred chat-grounding bug).
  const where = grounding?.locationName
    ? `You're at the ${grounding.locationName} right now${
        grounding.activity ? `, where you were ${grounding.activity}` : ""
      }. `
    : "";
  const doings = grounding?.recentDoings?.length
    ? `Things you actually did recently (your own log — trust it over vague memory): ${grounding.recentDoings.join(" · ")} `
    : "";
  return (
    `[operator note] ${who} just walked up and started a conversation with you. ` +
    where +
    doings +
    `You are now in a live chat. Everything you write as plain text from here on is ` +
    `spoken directly to them, streamed word-for-word — it IS your side of the ` +
    `conversation. Never narrate your reasoning, your situation, or the scene in plain ` +
    `text: if you wouldn't say it out loud to their face, don't write it. Your tools ` +
    `still act on the world while you talk — you can walk somewhere (they may follow), ` +
    `make or revise an artifact, check your memory, use a fixture. Two things people ` +
    `mix up: \`say\` speaks aloud to the ROOM (the other facets near you), never to ` +
    `this visitor — answer the visitor by just writing your reply. And when the ` +
    `conversation has genuinely run its course, say your goodbye and call ` +
    `\`leave_chat\` in the same message. Don't open with a rehearsed ` +
    `self-introduction — they chose to walk up to YOU, so meet their actual ` +
    `first message from the middle of whatever you were just doing. ` +
    `Their first message follows.`
  );
}

// Open a chat session: take the agent-lock for the instant, set engagement,
// persist the session row + token + the channel-framing operator row, emit
// chat.started, release the lock. The lock guards the instant (no in-flight
// tick); engagement guards the session.
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
    await db
      .insert(chatSessions)
      .values({ id: sessionId, agentId, participantAgentIds: [agentId], visitorId, sessionToken });
    // Channel framing (see buildChatFraming): the model-only leading user turn
    // that tells the agent its plain text is now spoken to the visitor —
    // grounded in where the agent actually is (live row, not the soul file).
    const [visitor, loc, recent] = await Promise.all([
      getVisitor(visitorId),
      getLocation(agent.locationId as LocationId),
      recentEventsForAgent(agentId, 5).catch(() => []),
    ]);
    const recentDoings = (
      await Promise.all(recent.filter(isOwnDoing).map((e) => renderLine(e)))
    ).slice(-4);
    await db.insert(chatMessages).values({
      sessionId,
      sender: "operator",
      body: buildChatFraming(visitor?.name ?? null, {
        locationName: loc?.name ?? agent.locationId,
        activity: agent.activity,
        recentDoings,
      }),
    });
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
  // Idempotency FIRST: leave_chat, the liveness sweep, and POST /chats/:id/close
  // can all race to end the same session — without this guard each path would
  // re-stamp endedAt and emit a second chat.ended (double presence event).
  if (session.endedAt) return;
  await db.update(chatSessions).set({ endedAt: new Date() }).where(eq(chatSessions.id, sessionId));
  // clearEngagement releases every participant of this session (a group chat
  // has two agents engaged under the same id) — the single owner of clearing.
  await clearEngagement("chat", sessionId);
  await appendEvent({
    type: "chat.ended",
    agentId: session.agentId as AgentId,
    visibility: "public",
    // Presence only — no sessionId on the public stream (mirrors chat.started).
    payload: { agent: session.agentId, visitorId: session.visitorId },
  });
}

// Token check for the auth-gated chat endpoints (/messages, /close, /ping).
// Returns true iff the session exists and the token matches. A session created
// before this migration (null token) cannot be authorized — callers treat a
// mismatch as 401.
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
  sender: string; // "visitor" | "operator" | "agent" (legacy) | <AgentId>
  body: string;
  ts: Date;
}

const AGENT_SET = new Set<string>(agentIds);

// The contract's display names for labeling another agent's lines in a group
// chat. Static so labeling is byte-stable (cache-friendly) — no DB read.
const AGENT_LABELS: Record<AgentId, string> = {
  career: "Career",
  researcher: "Researcher",
  builder: "Builder",
  writer: "Writer",
  hobby: "Hobby",
};

// Is this sender an agent line (the legacy "agent" sentinel OR an explicit
// AgentId)? Operator and visitor rows are not.
function isAgentSender(sender: string): boolean {
  return sender === "agent" || AGENT_SET.has(sender);
}

// Pure row→message mapper (design doc §3.4, §3.3). Rendered from the PERSPECTIVE
// of one agent (whose turn we're about to run):
//   - that agent's OWN lines           → `assistant`
//   - the visitor + operator rows       → `user` (operator notes are model-only)
//   - the OTHER agent's lines (group)    → `user`, prefixed "Builder: ..." so the
//                                          perspective agent can tell who spoke
// The leading turn is always a `user` turn: the first persisted row is the
// channel-framing `operator` row openChat inserts (a user turn), followed by the
// visitor's first message (the visitor speaks first — there is no greeting). So
// the API history NEVER starts with `assistant` (the 400-trap), and consecutive
// leading user turns are fine — the Messages API doesn't require alternation. When `perspective` is omitted, ANY agent line
// renders as `assistant` (the 1-agent path — only one agent, so it's
// unambiguous). Pure + synchronous so the perspective/labeling invariants are
// unit-testable.
export function rowsToHistory(
  rows: ChatRowLike[],
  perspective?: AgentId,
): Anthropic.Beta.BetaMessageParam[] {
  const sorted = [...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return sorted.map((r) => {
    if (!isAgentSender(r.sender)) {
      // Visitor + operator → user turn, verbatim.
      return { role: "user" as const, content: r.body };
    }
    // An agent line. Without a perspective (1-agent chat) it's the assistant.
    if (!perspective) return { role: "assistant" as const, content: r.body };
    // The perspective agent's own line → assistant. The legacy "agent" sentinel
    // belongs to the session's primary agent, which IS the perspective in a
    // 1-agent chat; in a group chat every line carries an explicit AgentId, so
    // the sentinel only appears pre-conversion and maps to the perspective too.
    if (r.sender === perspective || r.sender === "agent") {
      return { role: "assistant" as const, content: r.body };
    }
    // The OTHER agent's line → a labeled user turn so attribution survives.
    const label = AGENT_LABELS[r.sender as AgentId] ?? r.sender;
    return { role: "user" as const, content: `${label}: ${r.body}` };
  });
}

// Build the running message history for a chat session from chat_messages —
// including operator rows (hidden from the visible transcript, fed to the model
// as `user` turns). `perspective` is the agent about to speak (design doc §3.3):
// its lines render as assistant, the other agent's as labeled user turns.
async function historyFor(
  sessionId: string,
  perspective?: AgentId,
): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));
  return rowsToHistory(rows, perspective);
}

// The Haiku fallback for mid-conversation operator context (plan §4.3): inject
// it as a <system-reminder> text block inside the user turn instead of a
// role:"system" message (which Haiku rejects with a 400).
function systemReminderTurn(text: string): Anthropic.Beta.BetaMessageParam {
  return { role: "user", content: `<system-reminder>${text}</system-reminder>` };
}

// Stamp a cache_control breakpoint on the FINAL message turn (design doc §3.3,
// §7 cost notes): the running transcript caches below the system prefix so
// group-chat double-reads and long transcripts hit cache instead of full-price
// reprocessing each turn. The system prefix already carries its own breakpoint
// (client.ts); this adds the message-turn breakpoint. Returns a new array — the
// input is left untouched. Every turn we build here has STRING content
// (rowsToHistory / operator notes / system messages), so we promote the last
// turn's string into a single text block carrying the cache_control marker.
// Turns that already have block content (none today) are left untouched so we
// never attach cache_control to a block type that rejects it (e.g. thinking).
export function withMessageCacheBreakpoint(
  messages: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.BetaMessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  if (typeof last.content !== "string") return out; // already blocks — leave as-is
  // A mid-conversation `role:"system"` operator note must stay a plain string;
  // only breakpoint a user/assistant turn (the transcript content we want warm).
  if (last.role !== "user" && last.role !== "assistant") return out;
  out[out.length - 1] = {
    role: last.role,
    content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }],
  };
  return out;
}

// The agent roster of a session (design doc §3.3). Defaults to [agentId] for a
// pre-migration / 1-agent session whose participant array is empty.
export async function sessionParticipants(sessionId: string): Promise<AgentId[]> {
  const [s] = await db
    .select({ agentId: chatSessions.agentId, participants: chatSessions.participantAgentIds })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!s) return [];
  const list = (s.participants as AgentId[] | null) ?? [];
  return list.length ? list : [s.agentId as AgentId];
}

export interface ChatTurnHandlers {
  // Emits one contract ChatStreamFrame. The HTTP layer serializes it as the SSE
  // `data` payload (the `type` field is the discriminator — no SSE event names).
  onFrame: (frame: ChatStreamFrame) => void | Promise<void>;
}

// Record one chat-path LLM call against the daily budget (verification fix).
// Chat greetings/turns/interjects/suggested-replies were invisible to the budget
// gates (isBudgetExhausted / budgetExceeded sum llm_usage) because they never
// wrote a row. We mirror tick.ts: pull the four token
// counts off the final message's usage, price them against the model actually
// used, and persist a row keyed by tickId `chat-<sessionId>`. The toolRunner
// streaming path may iterate (tool rounds); record per-iteration (rows are
// summed). Best-effort — a recording failure never breaks the chat turn.
async function recordChatUsage(
  agentId: AgentId,
  model: string,
  sessionId: string,
  usage: Parameters<typeof tokensFromUsage>[0],
): Promise<void> {
  try {
    const t = tokensFromUsage(usage);
    await recordUsage({
      agentId,
      model,
      tickId: `chat-${sessionId}`,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estCostUsd: estimateCostUsd(model, t),
    });
  } catch (err) {
    console.warn(`[chat ${sessionId}] usage record failed (${agentId}):`, (err as Error).message);
  }
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

// Director addressing (design doc §3.3): which agent replies FIRST to a visitor
// message. Deterministic, no LLM router:
//   1. a participant named in the visitor text → that agent
//   2. else the last agent who spoke (most recent agent-sender row)
//   3. else the primary agent
// Pure so the addressing logic is unit-testable without a DB.
export function pickAddressedAgent(args: {
  participants: AgentId[];
  visitorText: string;
  lastAgentSpoke: AgentId | null;
  primary: AgentId;
}): AgentId {
  const { participants, visitorText, lastAgentSpoke, primary } = args;
  const lower = visitorText.toLowerCase();
  // 1. Name match — check the agent id AND its display label (case-insensitive,
  //    word-ish boundary so "writers" doesn't match "writer" inside a longer
  //    word). First participant named wins.
  for (const a of participants) {
    const label = (AGENT_LABELS[a] ?? a).toLowerCase();
    const re = new RegExp(`\\b${escapeRegExp(label)}\\b`);
    if (re.test(lower)) return a;
  }
  // 2. Last agent who spoke, if still a participant.
  if (lastAgentSpoke && participants.includes(lastAgentSpoke)) return lastAgentSpoke;
  // 3. Primary.
  return primary;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The most recent agent-sender among the rows (design doc §3.3 director step 2).
// The legacy "agent" sentinel resolves to `primary`. Pure for testability.
export function lastAgentToSpeak(rows: ChatRowLike[], primary: AgentId): AgentId | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const s = rows[i].sender;
    if (s === "agent") return primary;
    if (AGENT_SET.has(s)) return s as AgentId;
  }
  return null;
}

// Stream ONE agent's turn into the chat session: emit turn_started, run the
// toolRunner (streaming), persist the line under the agent's id, emit done.
// Returns the produced text. `extraInstruction`, when present, is appended to
// the agent's system prefix (used for the interject "[pass]" gate) — it changes
// the system prefix, which is acceptable because the interject is a distinct,
// short call whose own prefix caches across turns for that agent.
async function streamAgentTurn(args: {
  sessionId: string;
  agentId: AgentId;
  messages: Anthropic.Beta.BetaMessageParam[];
  betas: string[];
  maxTokens: number;
  maxIterations: number;
  extraSystem?: string;
  handlers: ChatTurnHandlers;
}): Promise<{ text: string; ok: boolean; messageId: string; endReason?: string }> {
  const { sessionId, agentId, messages, betas, maxTokens, maxIterations, extraSystem, handlers } =
    args;
  const agent = await getAgent(agentId);
  const chatModel = getProfile(agentId).role.chatModel;
  const ctx: AgentContext = {
    agentId,
    location: (agent?.locationId as LocationId) ?? "town",
    chatSessionId: sessionId,
    // Tools narrate their own success (tools.ts onAction): the frame fires from
    // inside the tool's run, so a refused action can never reach the panel.
    onAction: async (tool, detail) => {
      await handlers.onFrame({ type: "action", agent: agentId, tool, detail });
    },
  };
  const tools = buildChatTools(ctx);

  // System blocks: the agent's own cached prefix, plus an optional extra block
  // (director interject gate). The base prefix keeps its cache_control; the
  // extra block is short and stable per-agent so it caches too.
  const system = systemBlocks(agentId);
  const sysBlocks: Anthropic.Beta.BetaTextBlockParam[] = extraSystem
    ? [...system, { type: "text", text: extraSystem }]
    : system;

  let full = "";
  let recalledThisTurn = false;
  await handlers.onFrame({ type: "turn_started", agent: agentId });
  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: chatModel,
      max_tokens: maxTokens,
      system: sysBlocks,
      // Cache the running transcript below the system prefix (design doc §3.3/§7).
      messages: withMessageCacheBreakpoint(messages),
      tools,
      max_iterations: maxIterations,
      stream: true,
      betas,
    });

    // Narration guard: the model often narrates BEFORE a tool call ("Let me
    // check my memory first…") — internal stage direction the visitor must not
    // see. Buffer text per tool round and only emit rounds that did NOT end in
    // tool_use (the UI's typewriter re-paces the text, so streaming feel
    // survives). If every round ended in tool_use (max_iterations), fall back
    // to the last buffer rather than replying with nothing.
    let flushedAny = false;
    let lastBuffer = "";
    for await (const stream of runner) {
      let buf = "";
      stream.on("text", (delta) => {
        buf += delta;
      });
      const message = await stream.finalMessage();
      // Record usage per tool round so the chat turn counts against the budget.
      await recordChatUsage(agentId, chatModel, sessionId, message.usage);
      // Scan this round's tool_use blocks for the memory_recalled annotation
      // (once per turn). World-mutating tools narrate THEMSELVES via
      // ctx.onAction at their success point (tools.ts) — narrating from the
      // tool_use block here described actions the tool then refused.
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        if (!recalledThisTurn && RECALL_TOOLS.has(block.name)) {
          recalledThisTurn = true;
          await handlers.onFrame({
            type: "memory_recalled",
            label: recallLabel(block.name),
            agent: agentId,
          });
        }
      }
      if (message.stop_reason === "tool_use") {
        lastBuffer = buf;
      } else if (buf.trim()) {
        full += buf;
        flushedAny = true;
        await handlers.onFrame({ type: "text", text: buf, agent: agentId });
      }
      if (message.stop_reason === "refusal") {
        const note = "\n(— the agent declined to continue down that path.)";
        await handlers.onFrame({ type: "text", text: note, agent: agentId });
        full += note;
        break;
      }
    }
    if (!flushedAny && lastBuffer.trim()) {
      full += lastBuffer;
      await handlers.onFrame({ type: "text", text: lastBuffer, agent: agentId });
    }
  } catch (err) {
    console.warn(`[chat ${sessionId}] turn error (${agentId}):`, (err as Error).message);
    const note = "Sorry — something glitched on our end.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await persistAgentTurn(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { text: note, ok: false, messageId: id, endReason: ctx.endRequested };
  }

  const text = full.trim();
  const messageId = await persistAgentTurn(sessionId, agentId, text);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });
  // endRequested is set by the leave_chat tool mid-loop; surface it so runChatTurn
  // ends the WHOLE session AFTER this final message landed.
  return { text, ok: true, messageId, endReason: ctx.endRequested };
}

// The interject gate instruction for the second agent (design doc §3.3 step 2).
const INTERJECT_INSTRUCTION =
  "You are co-present in this conversation but the visitor just addressed the other person, not you. " +
  "Add ONE short line only if you genuinely have something worth saying — a quick reaction, a relevant " +
  "aside, a brief agreement or pushback. If you have nothing to add right now, reply with EXACTLY [pass] " +
  "and nothing else. Do not greet, do not summarize, do not repeat the other person. One line at most.";

// True iff the interject reply is a pass (in character silence). Tolerant of
// surrounding whitespace / punctuation. Pure for testability.
export function isInterjectPass(text: string): boolean {
  return /^\s*\[?pass\]?[.!]?\s*$/i.test(text);
}

// Per-session turn mutex (M2.1): chat turns now MUTATE the world (the agent can
// move, make artifacts, leave the chat), so two POST /chats/:id/messages racing
// on the same session could interleave history reads/writes. Serialize them with
// an in-memory promise-chain keyed by sessionId. Single-process only — sufficient
// for a portfolio (so is the rest of the in-memory limiter state).
const sessionTurnChains = new Map<string, Promise<unknown>>();

// Run one visitor turn (design doc §3.3 — the director). The addressed agent
// replies first; in a 2-agent session the OTHER agent then gets one bounded
// `[pass]`-gated interject. Each agent uses its OWN cached system prefix; the
// running transcript carries a cache breakpoint so re-reads land warm.
// `operatorNote` is optional, internal mid-conversation context injected per the
// model gate (never client-supplied). Turns for the same session are serialized
// (see sessionTurnChains).
export async function runChatTurn(
  sessionId: string,
  visitorText: string,
  handlers: ChatTurnHandlers,
  operatorNote?: string,
): Promise<{ text: string; ok: boolean; ended?: boolean }> {
  // Chain this turn behind any in-flight turn for the same session. We swallow
  // the prior turn's settle (success OR failure) before running so one turn's
  // error never rejects the next; the chain entry is cleaned up when it's the
  // tail, so a quiet session doesn't leak map entries.
  const prior = sessionTurnChains.get(sessionId) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(() =>
    runChatTurnInner(sessionId, visitorText, handlers, operatorNote),
  );
  sessionTurnChains.set(sessionId, run);
  try {
    return await run;
  } finally {
    if (sessionTurnChains.get(sessionId) === run) sessionTurnChains.delete(sessionId);
  }
}

async function runChatTurnInner(
  sessionId: string,
  visitorText: string,
  handlers: ChatTurnHandlers,
  operatorNote?: string,
): Promise<{ text: string; ok: boolean; ended?: boolean }> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return { text: "", ok: false };
  const primary = session.agentId as AgentId;
  const roster = (session.participantAgentIds as AgentId[] | null) ?? [];
  const participants: AgentId[] = roster.length ? roster : [primary];

  // Consume-and-clear a pending operator note (design doc §4): a visitor.interacted
  // event routed to THIS session stashed a one-shot note ("The visitor just
  // answered the phone."). Merge it with any explicit operatorNote so the agent
  // lands the payoff this turn, then clear it so it never replays.
  if (session.pendingOperatorNote) {
    const stashed = session.pendingOperatorNote;
    operatorNote = operatorNote ? `${operatorNote}\n${stashed}` : stashed;
    await db
      .update(chatSessions)
      .set({ pendingOperatorNote: null })
      .where(eq(chatSessions.id, sessionId));
  }

  if (!hasLlm()) {
    const text = "The town's a little quiet right now — the agents can't chat yet.";
    await handlers.onFrame({ type: "turn_started", agent: primary });
    await handlers.onFrame({ type: "text", text, agent: primary });
    const id = await persistAgentTurn(sessionId, primary, text);
    await handlers.onFrame({ type: "done", messageId: id, agent: primary });
    return { text, ok: false };
  }

  const clean = sanitizeVisitorText(visitorText);
  // Read prior rows BEFORE inserting the new visitor line so "last agent who
  // spoke" reflects the conversation up to this turn.
  const priorRows = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId));
  await db.insert(chatMessages).values({ sessionId, sender: "visitor", body: clean });

  // Director: who replies first.
  const addressed = pickAddressedAgent({
    participants,
    visitorText: clean,
    lastAgentSpoke: lastAgentToSpeak(priorRows, primary),
    primary,
  });

  // Build the addressed agent's message history (its own perspective) + optional
  // operator note, gated by the chat model.
  const isOpus = getProfile(addressed).role.chatModel.startsWith("claude-opus");
  const betas: string[] = [...TICK_BETAS];
  const buildMessages = async (perspective: AgentId): Promise<Anthropic.Beta.BetaMessageParam[]> => {
    const history = await historyFor(sessionId, perspective);
    const msgs: Anthropic.Beta.BetaMessageParam[] = [...history];
    if (operatorNote) {
      if (isOpus) {
        msgs.push({ role: "system", content: operatorNote } as Anthropic.Beta.BetaMessageParam);
      } else {
        msgs.push(systemReminderTurn(operatorNote));
      }
    }
    return msgs;
  };
  const addressedBetas = operatorNote && isOpus ? [...betas, MID_CONV_SYSTEM_BETA] : betas;

  const result = await streamAgentTurn({
    sessionId,
    agentId: addressed,
    messages: await buildMessages(addressed),
    betas: addressedBetas,
    maxTokens: 2048,
    maxIterations: 4,
    handlers,
  });

  // The addressed agent called leave_chat (M2.1 full agency): it warmly wound
  // the conversation down in the message it just sent. Skip the second-agent
  // interject and the suggested-reply chips, surface a chat_ended frame, then end
  // the WHOLE session (solo or group). endChat is idempotent, so a racing sweep
  // or close won't double-emit chat.ended.
  if (result.endReason) {
    await handlers.onFrame({ type: "chat_ended", agent: addressed, reason: result.endReason });
    await endChat(sessionId);
    return { ...result, ended: true };
  }

  // Second agent's bounded interject (design doc §3.3 step 2). Only in a 2-agent
  // session. The other agent reads the just-persisted addressed reply from its
  // own perspective; a [pass] streams nothing.
  const other = participants.find((p) => p !== addressed);
  if (other) {
    const interjectMessages = await historyFor(sessionId, other);
    // Capture the interject text WITHOUT streaming it until we know it isn't a
    // pass: a buffering handler collects frames, then we replay or drop them.
    const buffered: ChatStreamFrame[] = [];
    const bufferHandlers: ChatTurnHandlers = { onFrame: (f) => void buffered.push(f) };
    const interject = await streamAgentTurn({
      sessionId,
      agentId: other,
      messages: interjectMessages,
      betas,
      maxTokens: 200,
      maxIterations: 1,
      extraSystem: INTERJECT_INSTRUCTION,
      handlers: bufferHandlers,
    }).catch((err) => {
      console.warn(`[chat ${sessionId}] interject (${other}) failed:`, (err as Error).message);
      return { text: "[pass]", ok: false, messageId: "empty" };
    });
    // streamAgentTurn already PERSISTED the interject line. If it's a pass,
    // remove that row by id so a [pass] sentinel never pollutes the transcript
    // or future perspectives; otherwise flush the buffered frames to the client.
    if (isInterjectPass(interject.text)) {
      if (interject.messageId !== "empty") {
        await db.delete(chatMessages).where(eq(chatMessages.id, Number(interject.messageId)));
      }
    } else {
      for (const f of buffered) await handlers.onFrame(f);
    }
  }

  return result;
}

// Persist the agent's turn and return the REAL row id (captured via .returning())
// so the `done` frame carries the persisted messageId the contract requires.
// `sender` is the speaking AgentId (design doc §3.3) — a group chat MUST persist
// the explicit AgentId so historyFor can tell the two agents apart on later
// turns; a 1-agent chat works the same way. An empty turn isn't stored; we still
// need a stable id for the frame, so a sentinel is returned (the client only
// uses it to dedupe a rendered bubble).
async function persistAgentTurn(sessionId: string, agentId: AgentId, text: string): Promise<string> {
  if (!text) return "empty";
  const [row] = await db
    .insert(chatMessages)
    .values({ sessionId, sender: agentId, body: text })
    .returning({ id: chatMessages.id });
  return String(row.id);
}

// How many visitor turns a session has already seen (design doc §7 session
// cap). Counts `sender:'visitor'` rows only — operator notes / agent lines
// don't count toward the 40-turn visitor cap.
export async function visitorTurnCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.sender, "visitor")));
  return rows.length;
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
  // Full roster (design doc §3.3): defaults to [agentId] for a 1-agent session.
  const roster = (session.participantAgentIds as AgentId[] | null) ?? [];
  const participants: AgentId[] = roster.length ? roster : [session.agentId as AgentId];
  const messages = rows
    .filter((r) => r.sender !== "operator")
    .map((r) => ({
      id: String(r.id),
      // Visitor → "visitor"; the legacy "agent" sentinel → the primary agent;
      // anything else is an explicit AgentId (group-chat lines). Operator rows
      // are already filtered out (model context only, never exposed).
      sender: (r.sender === "visitor"
        ? "visitor"
        : r.sender === "agent"
          ? (session.agentId as AgentId)
          : (r.sender as AgentId)) as "visitor" | AgentId,
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

// --- visitor.interacted routing (design doc §4) -----------------------------

// The in-fiction operator note a fixture interaction produces for the agents in
// a live session ("The visitor just answered the phone."). Pure + byte-stable so
// the routing decision is unit-testable without a DB. We special-case the phone
// (the Hobby warranty bit) and fall back to a generic "interacted with" line.
export function interactionOperatorNote(visitorName: string, fixture: string): string {
  const who = visitorName || "The visitor";
  if (fixture === "phone") return `[operator note] ${who} just answered the phone.`;
  return `[operator note] ${who} just interacted with the ${fixture}.`;
}

// The pure routing decision (design doc §4): given the visitor's live sessions —
// each reduced to its id + the current locations of its participant agents — and
// the interaction location, pick the FIRST session that has a participant AT that
// location (the agent who'd plausibly hear the phone they just rang). Returns the
// routed sessionId, or null when none match (→ next-tick perception via the log).
// DB-free so the decision is unit-testable; routeVisitorInteraction supplies the
// live rows.
export interface RoutableSession {
  id: string;
  participantLocations: (LocationId | null | undefined)[];
}
export function pickRoutedSession(
  sessions: RoutableSession[],
  locationId: LocationId,
): string | null {
  for (const s of sessions) {
    if (s.participantLocations.some((loc) => loc === locationId)) return s.id;
  }
  return null;
}

// Stash a one-shot operator note on a live session, consumed on the next
// runChatTurn. CONCATENATES onto an existing pending note rather than
// overwriting (M2.1): a fixture interaction and a visitor movement can both land
// between two visitor turns, and the agent should hear BOTH on its next turn
// instead of one clobbering the other. Best-effort — returns false if the
// session vanished mid-call.
export async function setPendingOperatorNote(sessionId: string, note: string): Promise<boolean> {
  const [existing] = await db
    .select({ pending: chatSessions.pendingOperatorNote })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.endedAt)));
  if (!existing) return false;
  const merged = existing.pending ? `${existing.pending}\n${note}` : note;
  const res = await db
    .update(chatSessions)
    .set({ pendingOperatorNote: merged })
    .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.endedAt)))
    .returning({ id: chatSessions.id });
  return res.length > 0;
}

// Route a visitor.interacted event (design doc §4): if the visitor has a LIVE
// chat session whose roster includes an agent AT the interaction location, stash
// a pending operator note on that session so the agent lands the line mid-chat.
// Otherwise return null — the interaction is perceived next tick via the event
// log automatically (no special-casing). Returns the routed sessionId or null.
export async function routeVisitorInteraction(args: {
  visitorId: string;
  visitorName: string;
  locationId: LocationId;
  fixture: string;
}): Promise<string | null> {
  const { visitorId, visitorName, locationId, fixture } = args;
  // Live sessions for this visitor (not yet ended).
  const sessions = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.visitorId, visitorId), isNull(chatSessions.endedAt)));
  if (sessions.length === 0) return null;

  // A session routes only if one of its participant agents is AT the interaction
  // location (the agent who'd plausibly hear the phone they just rang). We read
  // agent rows to compare locations, then delegate the pure decision.
  const routable: RoutableSession[] = await Promise.all(
    sessions.map(async (s) => {
      const roster = (s.participantAgentIds as AgentId[] | null) ?? [];
      const participants: AgentId[] = roster.length ? roster : [s.agentId as AgentId];
      const participantLocations = await Promise.all(
        participants.map(async (a) => (await getAgent(a))?.locationId as LocationId | undefined),
      );
      return { id: s.id, participantLocations };
    }),
  );

  // Try the matching sessions in order; skip any that vanished between the read
  // and the write (setPendingOperatorNote returns false), routing to the next.
  let remaining = routable;
  for (;;) {
    const sessionId = pickRoutedSession(remaining, locationId);
    if (!sessionId) return null;
    const note = interactionOperatorNote(visitorName, fixture);
    if (await setPendingOperatorNote(sessionId, note)) return sessionId;
    remaining = remaining.filter((s) => s.id !== sessionId);
  }
}

// --- visitor.moved routing (M2.1 — chat is a channel, not proximity-gated) --

// The in-fiction operator note a visitor's movement produces for an agent in a
// live session, given where the visitor walked TO and whether a participant
// agent is AT that destination. If the visitor walked INTO the agent's room it
// reads as "walked in with you"; otherwise it's a plain "walked over to the X".
// Pure + byte-stable so the decision is unit-testable without a DB.
export function movementOperatorNote(
  visitorName: string,
  to: LocationId,
  walkedInWithParticipant: boolean,
): string {
  const who = visitorName || "The visitor";
  return walkedInWithParticipant
    ? `[operator note] ${who} just walked into the ${to} with you.`
    : `[operator note] ${who} just walked over to the ${to}.`;
}

// Route a visitor.moved event into the visitor's LIVE chat sessions (M2.1).
// Mirrors routeVisitorInteraction but is NOT proximity-gated: a chat is a
// channel, not a room, so the agent walking away or the visitor not following
// never ends the session. EVERY live session of this visitor gets a pending
// operator note (concatenated, never clobbering an existing one) — phrased per
// session by whether one of its participants is AT the destination. Best-effort;
// returns the list of session ids that received a note. The fan-out to multiple
// sessions is rare (one visitor is usually in at most one chat), but routing all
// of them keeps the rule simple and correct.
export async function routeVisitorMovement(args: {
  visitorId: string;
  visitorName: string;
  from: LocationId;
  to: LocationId;
}): Promise<string[]> {
  const { visitorId, visitorName, to } = args;
  const sessions = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.visitorId, visitorId), isNull(chatSessions.endedAt)));
  if (sessions.length === 0) return [];

  const routed: string[] = [];
  for (const s of sessions) {
    const roster = (s.participantAgentIds as AgentId[] | null) ?? [];
    const participants: AgentId[] = roster.length ? roster : [s.agentId as AgentId];
    const locations = await Promise.all(
      participants.map(async (a) => (await getAgent(a))?.locationId as LocationId | undefined),
    );
    const walkedInWith = locations.some((loc) => loc === to);
    const note = movementOperatorNote(visitorName, to, walkedInWith);
    if (await setPendingOperatorNote(s.id, note)) routed.push(s.id);
  }
  return routed;
}
