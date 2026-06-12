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
import { eq, isNull, desc } from "drizzle-orm";
import type { AgentId, LocationId, ChatStreamFrame } from "@town/contract";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { db, schema } from "../db/client.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS, MID_CONV_SYSTEM_BETA } from "./client.js";
import { getProfile } from "./roles.js";
import { buildChatTools, type AgentContext } from "./tools.js";
import { getAgent, setEngagement, clearEngagement } from "../engine/agents.js";
import { appendEvent } from "../engine/events.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
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

// Auto-close chat sessions abandoned without a /chats/:id/close call (the common
// case: the visitor closes the tab, loses network, or the browser never fires
// the close). Each such session leaves the agent busy=true forever, so the
// scheduler permanently skips it. The scheduler calls this on a timer; we end any
// open session whose last activity (last message, else startedAt) is older than
// `staleMs`, which also clears the agent's busy flag via endChat.
export async function sweepStaleChats(staleMs = 10 * 60_000): Promise<void> {
  const open = await db.select().from(chatSessions).where(isNull(chatSessions.endedAt));
  const now = Date.now();
  for (const s of open) {
    const [lastMsg] = await db
      .select({ ts: chatMessages.ts })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, s.id))
      .orderBy(desc(chatMessages.ts))
      .limit(1);
    const lastActivity = (lastMsg?.ts ?? s.startedAt).getTime();
    if (now - lastActivity >= staleMs) {
      console.log(`[chat] auto-closing stale session ${s.id} (agent ${s.agentId}).`);
      await endChat(s.id);
    }
  }
}

// Build the running message history for a chat session from chat_messages.
async function historyFor(sessionId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));
  rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return rows.map((r) => ({
    role: r.sender === "agent" ? ("assistant" as const) : ("user" as const),
    content: r.body,
  }));
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
