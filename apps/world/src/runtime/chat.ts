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
import { eq } from "drizzle-orm";
import type { AgentId, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS, MID_CONV_SYSTEM_BETA } from "./client.js";
import { getProfile } from "./roles.js";
import { buildChatTools, type AgentContext } from "./tools.js";
import { getAgent, setBusy } from "../engine/agents.js";
import { appendEvent } from "../engine/events.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";

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

export interface OpenChatResult {
  sessionId: string;
}

// Open a chat session: mark agent busy, persist the session row, emit
// chat.started. Returns the session id the browser POSTs messages to.
export async function openChat(agentId: AgentId, visitorId: string): Promise<OpenChatResult | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const sessionId = randomUUID();
  await db.insert(chatSessions).values({ id: sessionId, agentId, visitorId });
  await setBusy(agentId, true);
  await appendEvent({
    type: "chat.started",
    agentId,
    visibility: "public",
    payload: { agent: agentId, visitorId, sessionId },
  });
  return { sessionId };
}

export async function endChat(sessionId: string): Promise<void> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return;
  await db.update(chatSessions).set({ endedAt: new Date() }).where(eq(chatSessions.id, sessionId));
  await setBusy(session.agentId as AgentId, false);
  await appendEvent({
    type: "chat.ended",
    agentId: session.agentId as AgentId,
    visibility: "public",
    payload: { agent: session.agentId, visitorId: session.visitorId, sessionId },
  });
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
  onText: (delta: string) => void | Promise<void>;
}

// Run one visitor turn: append the (sanitized) visitor message, stream the
// agent's reply to the caller, persist both, return the full reply text.
// `operatorNote` is optional mid-conversation context (e.g. "the visitor just
// arrived from the town square") injected per the model gate.
export async function runChatTurn(
  sessionId: string,
  visitorText: string,
  handlers: ChatTurnHandlers,
  operatorNote?: string,
): Promise<{ text: string; ok: boolean }> {
  if (!hasLlm()) {
    const text = "The town's a little quiet right now — the agents can't chat yet.";
    await handlers.onText(text);
    return { text, ok: false };
  }
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return { text: "", ok: false };
  const agentId = session.agentId as AgentId;
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
        void handlers.onText(delta);
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        const note = "\n(— the agent declined to continue down that path.)";
        await handlers.onText(note);
        full += note;
        break;
      }
    }
  } catch (err) {
    console.warn(`[chat ${sessionId}] error:`, (err as Error).message);
    const note = "Sorry — something glitched on our end.";
    await handlers.onText(note);
    return { text: note, ok: false };
  }

  if (full.trim()) {
    await db.insert(chatMessages).values({ sessionId, sender: "agent", body: full.trim() });
  }
  return { text: full.trim(), ok: true };
}
