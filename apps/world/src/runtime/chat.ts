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
import { getScene, convertScene } from "./conversation-scene.js";

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
    await db
      .insert(chatSessions)
      .values({ id: sessionId, agentId, participantAgentIds: [agentId], visitorId, sessionToken });
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

// joinConversation outcomes (design doc §3.3a — visitor interjects into a live
// scene):
//   - ok       → scene converted to a group chat with BOTH agents; carries the
//                new session id, token, and participants
//   - gone     → no such live scene (already ended / never existed) → 409
//   - converted→ another visitor won the interject race (CAS lost) → 409
export type JoinConversationResult =
  | {
      status: "ok";
      sessionId: string;
      agentId: AgentId;
      visitorId: string;
      participants: AgentId[];
      sessionToken: string;
    }
  | { status: "gone" }
  | { status: "converted" };

// One labeled scene line, rendered as an operator/context row when seeding the
// converted chat's transcript. Exported pure helper so the seeding format is
// unit-testable. Each scene turn becomes an `operator` row "Builder: ..." so
// historyFor folds it into the model's leading user context (never shown to the
// visitor, never an assistant turn that would mis-attribute the line).
export function seedRowForSceneLine(line: { agent: AgentId; text: string }): {
  sender: "operator";
  body: string;
} {
  const label = AGENT_LABELS[line.agent] ?? line.agent;
  return { sender: "operator", body: `${label}: ${line.text}` };
}

// Convert a live scene into a group chat the visitor joins (design doc §3.1,
// §3.3a). Atomic transfer of engagement from scene→chat: we create the chat
// session with BOTH agents as participants, set their engagement to the chat
// session id (replacing the scene engagement under the SAME agents), seed the
// transcript with the scene lines as labeled operator/context rows + an operator
// note that a visitor jumped in, THEN CAS-convert the scene (which fires the
// abort and emits conversation.converted). Registry CAS: first visitor wins; a
// gone / already-converted scene returns a 409-mapping status.
export async function joinConversation(
  conversationId: string,
  visitorId: string,
): Promise<JoinConversationResult> {
  const scene = getScene(conversationId);
  if (!scene) return { status: "gone" };
  if (scene.convertedTo || scene.interrupted) return { status: "converted" };

  const [a, b] = scene.participants;
  const sessionId = randomUUID();
  const sessionToken = randomUUID();
  // Create the chat session with both agents as participants. The PRIMARY agent
  // (agentId) is the initiator — the addressed-agent director defaults to it
  // until the visitor names one.
  await db.insert(chatSessions).values({
    id: sessionId,
    agentId: a,
    participantAgentIds: [a, b],
    visitorId,
    sessionToken,
  });

  // Seed the transcript with the scene lines as labeled operator rows so the
  // agents have the conversation context the visitor just walked into.
  const seedRows = scene.lines.map((l) => ({
    sessionId,
    ...seedRowForSceneLine(l),
  }));
  if (seedRows.length) await db.insert(chatMessages).values(seedRows);
  // An operator note tells the agents a visitor jumped into their conversation.
  await db.insert(chatMessages).values({
    sessionId,
    sender: "operator",
    body:
      "[operator note] A visitor just jumped into your conversation — they can now hear and talk to both of you. React to the interruption in character.",
  });

  // Atomic engagement hand-off: set BOTH agents' engagement to the chat session
  // (same agents, new {kind:'chat', id}) BEFORE the CAS, so there is never a
  // window where they're unengaged. clearEngagement isn't called for the scene —
  // setEngagement overwrites the row, and the scene's converted branch is told
  // (by convertScene) NOT to clear engagement.
  await setEngagement("chat", sessionId, [a, b]);

  // CAS-convert the scene. The CAS is synchronous, so exactly one of two racing
  // joins wins. If we lost (another join landed first), undo: tear down the chat
  // session we speculatively created and report `converted`. NOTE: a losing
  // racer's setEngagement above may have overwritten the winner's engagement, so
  // the WINNER re-asserts engagement after the CAS to make its session id final.
  const won = convertScene(conversationId, sessionId);
  if (!won) {
    await db.update(chatSessions).set({ endedAt: new Date() }).where(eq(chatSessions.id, sessionId));
    return { status: "converted" };
  }
  await setEngagement("chat", sessionId, [a, b]);

  // chat.started is PUBLIC presence only — no sessionId (design doc §3.3).
  await appendEvent({
    type: "chat.started",
    agentId: a,
    visibility: "public",
    payload: { agent: a, visitorId },
  });

  return {
    status: "ok",
    sessionId,
    agentId: a,
    visitorId,
    participants: [a, b],
    sessionToken,
  };
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
// Because the byte-stable operator opener persists FIRST, the leading turn is
// always a `user` turn, so the API history NEVER starts with `assistant` (the
// 400-trap). When `perspective` is omitted, ANY agent line renders as
// `assistant` (the 1-agent path — there's only one agent, so it's unambiguous).
// Pure + synchronous so the perspective/labeling invariants are unit-testable.
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
}): Promise<{ text: string; ok: boolean; messageId: string }> {
  const { sessionId, agentId, messages, betas, maxTokens, maxIterations, extraSystem, handlers } =
    args;
  const agent = await getAgent(agentId);
  const ctx: AgentContext = {
    agentId,
    location: (agent?.locationId as LocationId) ?? "town",
    conversationId: null,
    chatSessionId: sessionId,
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
      model: getProfile(agentId).role.chatModel,
      max_tokens: maxTokens,
      system: sysBlocks,
      // Cache the running transcript below the system prefix (design doc §3.3/§7).
      messages: withMessageCacheBreakpoint(messages),
      tools,
      max_iterations: maxIterations,
      stream: true,
      betas,
    });

    for await (const stream of runner) {
      stream.on("text", (delta) => {
        full += delta;
        void handlers.onFrame({ type: "text", text: delta, agent: agentId });
      });
      const message = await stream.finalMessage();
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
    console.warn(`[chat ${sessionId}] turn error (${agentId}):`, (err as Error).message);
    const note = "Sorry — something glitched on our end.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await persistAgentTurn(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { text: note, ok: false, messageId: id };
  }

  const text = full.trim();
  const messageId = await persistAgentTurn(sessionId, agentId, text);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });
  return { text, ok: true, messageId };
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

// Run one visitor turn (design doc §3.3 — the director). The addressed agent
// replies first; in a 2-agent session the OTHER agent then gets one bounded
// `[pass]`-gated interject. Each agent uses its OWN cached system prefix; the
// running transcript carries a cache breakpoint so re-reads land warm.
// `operatorNote` is optional, internal mid-conversation context injected per the
// model gate (never client-supplied).
export async function runChatTurn(
  sessionId: string,
  visitorText: string,
  handlers: ChatTurnHandlers,
  operatorNote?: string,
): Promise<{ text: string; ok: boolean }> {
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
    const id = await persistAgentTurn(sessionId, agentId, text);
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
  // The greeting is single-agent: perspective = the greeting agent.
  const messages = await historyFor(sessionId, agentId);

  let full = "";
  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: profile.role.chatModel,
      max_tokens: 1024,
      system: systemBlocks(agentId),
      messages: withMessageCacheBreakpoint(messages),
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
    const id = await persistAgentTurn(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { status: "ok", text: note };
  }

  const text = full.trim() || "Oh — hi there. Come on in.";
  const messageId = await persistAgentTurn(sessionId, agentId, text);
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

// How many visitor turns a session has already seen (design doc §7 session
// cap). Counts `sender:'visitor'` rows only — operator opener / agent lines /
// scene-seed rows don't count toward the 40-turn visitor cap.
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

// Stash a one-shot operator note on a live session, consumed on the next
// runChatTurn. Best-effort — returns false if the session vanished mid-call.
export async function setPendingOperatorNote(sessionId: string, note: string): Promise<boolean> {
  const res = await db
    .update(chatSessions)
    .set({ pendingOperatorNote: note })
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
  // agent rows to compare locations.
  for (const s of sessions) {
    const roster = (s.participantAgentIds as AgentId[] | null) ?? [];
    const participants: AgentId[] = roster.length ? roster : [s.agentId as AgentId];
    const located = await Promise.all(
      participants.map(async (a) => (await getAgent(a))?.locationId),
    );
    if (located.some((loc) => loc === locationId)) {
      const note = interactionOperatorNote(visitorName, fixture);
      const ok = await setPendingOperatorNote(s.id, note);
      if (ok) return s.id;
    }
  }
  return null;
}
