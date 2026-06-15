// The agent loop (M3 continuity). One continuous, self-compacting thread per
// agent; ONE input-driven loop, no tick-vs-chat split. The per-agent queue
// (queue.ts) serializes inputs and calls executeInput() below for each; the
// shared turn machinery (turn.ts) runs it on the persistent thread.
//
// Speech unification (design §3): plain assistant text is the agent's UTTERANCE.
// If someone is present (a co-located facet or a visitor), it's SPEECH —
// agent.spoke, a speech bubble, heard by the room; if the agent is alone, it's a
// thought-aloud — agent.thought, a wisp. There is exactly one way to talk: write
// it. (The old `say` tool + say-boost are gone.) Addressing a co-located facet by
// name pushes them an immediate (interrupt) turn so conversations flow.
//
// Design source: vault "Thomas's Town — Memory & Continuity Architecture".

import { randomUUID } from "node:crypto";
import type { AgentId, LocationId } from "@town/contract";
import { agentIds } from "@town/contract";
import { config } from "../config.js";
import { hasLlm } from "./client.js";
import { getProfile, soulGitHash } from "./roles.js";
import { buildTools, type AgentContext } from "./tools.js";
import { buildDelta, writeCursor } from "./observation.js";
import { getAgent, setStatus, setActivity, markTicked } from "../engine/agents.js";
import { agentsAtLocation } from "../engine/locations.js";
import { visitorsAtLocation } from "../engine/visitors.js";
import { appendEvent } from "../engine/events.js";
import { markRead } from "../engine/messages.js";
import { spendTodayUsd, spendTodayForAgent } from "../engine/usage.js";
import { startTrace } from "./tracing.js";
import { runTurn, type TurnOutcome } from "./turn.js";
import { runReflection } from "./reflection.js";
import {
  enqueue,
  registerExecutor,
  type AgentInput,
  type ExecResult,
} from "./queue.js";
import {
  appendVisitorLine,
  appendAgentLine,
  sanitizeVisitorText,
  endSession,
} from "./chat.js";

export const SLEEPING_BUDGET = "sleeping (budget)";

// Ordered-pair throttle for addressed-speech interrupts (speaker→addressee): an
// addressed facet is pushed an immediate turn at most this often, so A↔B can't
// ping-pong faster than the window. In-memory (single-process).
const ADDRESS_THROTTLE_MS = 90_000;
const lastAddressAt = new Map<string, number>();

// Pure budget-cap decision: a turn is blocked when either the global daily
// ceiling OR the agent's per-role soft cap is met. Unit-testable.
export function budgetExceeded(opts: {
  globalSpendUsd: number;
  globalCapUsd: number;
  agentSpendUsd: number;
  agentCapUsd: number;
}): boolean {
  return (
    opts.globalSpendUsd >= opts.globalCapUsd || opts.agentSpendUsd >= opts.agentCapUsd
  );
}

export interface TickResult extends ExecResult {
  reason?:
    | "no-llm"
    | "budget"
    | "ok"
    | "refusal"
    | "error"
    | "coalesced"
    | "no-executor";
}

// The executor the queue calls for each input. Dispatches by kind. Never throws
// to the queue in a way that strands the agent — returns a structured result.
async function executeInput(agentId: AgentId, input: AgentInput): Promise<ExecResult> {
  switch (input.kind) {
    case "tick":
      return runTickInput(agentId);
    case "reflection":
      return runReflection(agentId).then((r) => ({ ran: r.ran, reason: "ok" }));
    case "visitor":
      return runVisitorInput(agentId, input);
  }
}

registerExecutor(executeInput);

// --- tick -------------------------------------------------------------------

async function runTickInput(agentId: AgentId): Promise<TickResult> {
  if (!hasLlm()) return { ran: false, reason: "no-llm" };
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };

  // Budget gates: global hard ceiling + per-role soft cap. Either trips → status
  // "sleeping (budget)"; the scheduler stops enqueuing ticks until UTC midnight.
  const profile = getProfile(agentId);
  const [globalSpend, agentSpend] = await Promise.all([
    spendTodayUsd(),
    spendTodayForAgent(agentId),
  ]);
  if (
    budgetExceeded({
      globalSpendUsd: globalSpend,
      globalCapUsd: config.dailyBudgetUsd,
      agentSpendUsd: agentSpend,
      agentCapUsd: profile.role.dailyTokenBudgetUsd,
    })
  ) {
    if (agent.status !== SLEEPING_BUDGET) {
      await setStatus(agentId, SLEEPING_BUDGET);
      await setActivity(agentId, "resting — out of energy for today");
    }
    return { ran: false, reason: "budget" };
  }
  if (agent.status === SLEEPING_BUDGET) {
    await setStatus(agentId, "awake");
    await setActivity(agentId, "back at it after a rest");
  }

  const tickId = `tick-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("tick", {
    userId: agentId,
    sessionId: utcDay(),
    metadata: { soulVersion: agent.soulVersion, soulGitHash: soulGitHash(agentId) },
  });

  // The world delta (pure SQL, push/pull): standing state + notice-push since the
  // last input, self-events and elsewhere-events excluded. Appended to the thread.
  const obs = await buildDelta(agentId);
  const ctx: AgentContext = { agentId, location: obs.location };
  const tools = buildTools(ctx);

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn({
      agentId,
      model: profile.role.tickModel,
      maxTokens: 4096,
      inputText: obs.text,
      tools,
      advanceCursorTo: Number(obs.highWaterEventId),
      tickId,
      trace,
    });
  } catch (err) {
    console.warn(`[tick ${agentId}] error:`, (err as Error).message);
    trace.end({ error: (err as Error).message });
    await markTicked(agentId);
    return { ran: false, reason: "error", traceId: trace.traceId };
  }

  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);
  if (agent.status !== "awake") await setStatus(agentId, "awake");

  // Utterance: speech if anyone's present, a thought-aloud if alone.
  if (outcome.finalText && !outcome.refused) {
    await emitUtterance(agentId, ctx.location, outcome.finalText);
  }

  trace.end({
    rounds: outcome.rounds,
    totalCost: outcome.totalCost,
    totalCacheRead: outcome.totalCacheRead,
    refused: outcome.refused,
  });
  console.log(
    `[tick ${agentId}] rounds=${outcome.rounds} cacheRead=${outcome.totalCacheRead} cost=$${outcome.totalCost.toFixed(4)}${
      outcome.refused ? " refused" : ""
    }`,
  );

  return {
    ran: true,
    reason: outcome.refused ? "refusal" : "ok",
    rounds: outcome.rounds,
    costUsd: outcome.totalCost,
    cacheReadTokens: outcome.totalCacheRead,
    traceId: trace.traceId,
  };
}

// --- visitor turn (chats in the thread) -------------------------------------

async function runVisitorInput(
  agentId: AgentId,
  input: Extract<AgentInput, { kind: "visitor" }>,
): Promise<ExecResult> {
  const { sessionId, visitorName, handlers } = input;
  const text = sanitizeVisitorText(input.text);
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };

  if (!hasLlm()) {
    const note = "The town's a little quiet right now — the agents can't chat yet.";
    await handlers.onFrame({ type: "turn_started", agent: agentId });
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await appendAgentLine(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { ran: false, reason: "no-llm" };
  }

  await appendVisitorLine(sessionId, text);

  const tickId = `chat-${sessionId}`;
  const trace = startTrace("visitor", {
    userId: agentId,
    sessionId,
    metadata: { soulGitHash: soulGitHash(agentId) },
  });

  // The visitor's words ride on a fresh world delta so the agent answers from
  // where it actually is, with whoever's present — appended as an interrupt input
  // to its continuous thread (the conversation lives IN its consciousness).
  const obs = await buildDelta(agentId);
  const inputText = `${obs.text}\n\n## A visitor speaks to you\n${visitorName || "A visitor"} (here with you) says: "${text}"\n\nWhatever you write as plain text is spoken back to them, streamed word-for-word — so just talk, don't narrate what you're about to do (do it quietly with a tool instead). How you respond is entirely yours: engage warmly, be brief, or stay in your own world if that's truer to the moment — they share the town with you, they aren't an audience you owe a performance. You keep all your tools (walk somewhere, make something, check your memory). When a conversation has run its course, say your goodbye and call leave_chat in the same message.`;

  const ctx: AgentContext = {
    agentId,
    location: obs.location,
    onAction: async (tool, detail) => {
      await handlers.onFrame({ type: "action", agent: agentId, tool, detail });
    },
  };
  const tools = buildTools(ctx);

  await handlers.onFrame({ type: "turn_started", agent: agentId });

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn({
      agentId,
      model: profile(agentId).chatModel,
      maxTokens: 2048,
      inputText,
      tools,
      advanceCursorTo: Number(obs.highWaterEventId),
      tickId,
      trace,
      stream: handlers,
    });
  } catch (err) {
    console.warn(`[visitor ${agentId}] turn error:`, (err as Error).message);
    trace.end({ error: (err as Error).message });
    const note = "Sorry — something glitched on our end.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await appendAgentLine(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { ran: false, reason: "error", traceId: trace.traceId };
  }

  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);

  const reply = outcome.finalText.trim();
  const messageId = await appendAgentLine(sessionId, agentId, reply);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });

  // The reply is SPEECH (a visitor is present) — surface it to the world too
  // (bubble + co-located facets), then push any addressed facet.
  if (reply && !outcome.refused) {
    await emitUtterance(agentId, ctx.location, reply, { audience: true });
  }

  // leave_chat fired mid-turn → end the session after the final message landed.
  if (ctx.endRequested) {
    await handlers.onFrame({ type: "chat_ended", agent: agentId, reason: ctx.endRequested });
    await endSession(sessionId);
  }

  trace.end({ rounds: outcome.rounds, refused: outcome.refused });
  return { ran: true, reason: outcome.refused ? "refusal" : "ok", traceId: trace.traceId };
}

function profile(agentId: AgentId) {
  return getProfile(agentId).role;
}

// --- utterance (speech vs thought) ------------------------------------------

// Emit the agent's plain-text utterance. Speech (agent.spoke, heard by the room +
// any present visitor) when there's an audience; a thought-aloud (agent.thought,
// a public wisp) when the agent is alone. `opts.audience` forces speech (visitor
// turns); otherwise we look up co-presence. Addressing a co-located facet by name
// pushes it an immediate (interrupt) turn so the conversation continues.
async function emitUtterance(
  agentId: AgentId,
  location: LocationId,
  text: string,
  opts: { audience?: boolean } = {},
): Promise<void> {
  const here = await agentsAtLocation(location, agentId).catch(() => []);
  let hasAudience = opts.audience === true || here.length > 0;
  if (!hasAudience) {
    const visitorsHere = await visitorsAtLocation(location).catch(() => []);
    hasAudience = visitorsHere.length > 0;
  }

  if (!hasAudience) {
    await appendEvent({
      type: "agent.thought",
      agentId,
      locationId: location,
      visibility: "public",
      payload: { agent: agentId, text },
    });
    return;
  }

  await appendEvent({
    type: "agent.spoke",
    agentId,
    locationId: location,
    visibility: "location",
    payload: { agent: agentId, location, text },
  });

  // Push any co-located facet addressed by name an immediate turn (throttled per
  // ordered pair so a back-and-forth can't loop faster than the window). The
  // addressed facet's delta will surface this speech (co-located notice-push).
  const lower = text.toLowerCase();
  for (const other of here) {
    const label = (AGENT_LABELS[other.id as AgentId] ?? other.id).toLowerCase();
    if (!new RegExp(`\\b${escapeRegExp(label)}\\b`).test(lower)) continue;
    const key = `${agentId}|${other.id}`;
    const now = Date.now();
    if (now - (lastAddressAt.get(key) ?? 0) < ADDRESS_THROTTLE_MS) continue;
    lastAddressAt.set(key, now);
    void enqueue(other.id as AgentId, { kind: "tick", interrupt: true }).catch((err) =>
      console.warn(`[loop] address-push ${other.id} failed:`, (err as Error).message),
    );
  }
}

const AGENT_LABELS: Record<AgentId, string> = {
  career: "Career",
  researcher: "Researcher",
  builder: "Builder",
  writer: "Writer",
  hobby: "Hobby",
};
void agentIds;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- entry points -----------------------------------------------------------

// Force one tick for an agent (POST /admin/tick, smoke tests). Enqueues an
// interrupt tick and awaits its result.
export async function runTick(agentId: AgentId): Promise<ExecResult> {
  return enqueue(agentId, { kind: "tick", interrupt: true });
}

// Test seam.
export function _resetAddressThrottleForTest(): void {
  lastAddressAt.clear();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
