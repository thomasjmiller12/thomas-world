// The unified agent loop (M3 continuity). One continuous, self-compacting thread
// per agent — the Claude Code model. There is no tick-vs-chat split anymore: an
// INPUT (a tick delta, later a visitor message or co-located speech) is appended
// to the persistent thread and runs one bounded turn; the SDK tool runner owns
// the dispatch, the server compacts the thread as it grows, and we re-persist the
// accumulated thread (incl. compaction blocks) after every SUCCESSFUL turn.
//
// This replaces the old runtime/tick.ts (a chatbot re-prompted from scratch every
// tick). Design source: vault "Thomas's Town — Memory & Continuity Architecture".
//
// We DO NOT hand-roll the dispatch loop — the SDK's toolRunner owns it (verified
// in Phase 0 to forward context_management and accumulate the full thread,
// including server-side compaction blocks, into runner.params.messages).

import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";
import { randomUUID } from "node:crypto";
import type { AgentId } from "@town/contract";
import { config } from "../config.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS } from "./client.js";
import { getProfile, soulGitHash } from "./roles.js";
import { buildTools, type AgentContext } from "./tools.js";
import { buildDelta, writeCursor } from "./observation.js";
import { getAgent, setStatus, setActivity, markTicked, isBusy } from "../engine/agents.js";
import { appendEvent } from "../engine/events.js";
import { markRead } from "../engine/messages.js";
import { recordUsage, spendTodayUsd, spendTodayForAgent } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { startTrace } from "./tracing.js";
import { tryAcquire } from "./agent-lock.js";
import {
  loadThread,
  persistThread,
  buildSeedContext,
  type ThreadMessage,
} from "../engine/thread.js";

// How many tool rounds a single turn may take before we force a stop.
const MAX_TURN_ROUNDS = 6;
export const SLEEPING_BUDGET = "sleeping (budget)";

// Server-side compaction (Phase 0). Beta header + the edit that compacts the
// thread once its input crosses the trigger. 50_000 is the API minimum (a lower
// value 400s) and our working-context floor; it's the main cost knob — higher =
// rarer but larger compaction passes. Phase 4 tunes it. After a compaction the
// working set collapses to the summary + recent tail, then grows back toward it.
const COMPACT_TRIGGER_TOKENS = 50_000;
const COMPACTION_BETA = "compact-2026-01-12";
export const LOOP_BETAS = [...TICK_BETAS, COMPACTION_BETA] as const;
const COMPACTION = {
  edits: [
    {
      type: "compact_20260112" as const,
      trigger: { type: "input_tokens" as const, value: COMPACT_TRIGGER_TOKENS },
    },
  ],
};

// Pure budget-cap decision: a turn is blocked when either the global daily
// ceiling OR the agent's per-role soft cap is met. Extracted so it's
// unit-testable without a DB or the LLM.
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

export interface TickResult {
  ran: boolean;
  reason?: "no-llm" | "busy" | "budget" | "ok" | "refusal" | "error";
  rounds?: number;
  costUsd?: number;
  cacheReadTokens?: number;
  // Langfuse trace id for this turn (empty when tracing is off). Surfaced by the
  // /admin/tick endpoint so a smoke test can verify the trace landed.
  traceId?: string;
}

interface TurnOutcome {
  rounds: number;
  totalCost: number;
  totalCacheRead: number;
  refused: boolean;
  // The agent's plain assistant text from the final end_turn (its "thought
  // aloud"). Empty if the turn ended without text (e.g. a pure tool turn).
  finalText: string;
}

// Run ONE turn on the agent's persistent thread. The CALLER owns the lock, the
// budget gate, and any cursor/inbox advance — this is the shared turn machinery
// for both ticks and reflection:
//   1. load the continuous thread (and orient it from the seed if it's fresh),
//   2. append `inputText` as a user turn (with a cache breakpoint — see below),
//   3. run the bounded tool runner with server-side compaction,
//   4. on success, persist the accumulated thread (incl. compaction blocks).
// A turn that throws propagates to the caller WITHOUT persisting, so the prior
// thread stays intact and the input simply retries on the next pass.
export async function runTurn(opts: {
  agentId: AgentId;
  model: string;
  maxTokens: number;
  inputText: string;
  tools: BetaRunnableTool<unknown>[];
  // The world-event high-water id this turn perceived, to store as the thread's
  // input cursor. Omit (undefined) to preserve the existing cursor — e.g. a
  // reflection turn perceives nothing new.
  advanceCursorTo?: number | null;
  tickId: string;
  trace: ReturnType<typeof startTrace>;
}): Promise<TurnOutcome> {
  const { agentId, model, maxTokens, inputText, tools, tickId, trace } = opts;

  const thread = await loadThread(agentId);
  // Strip any cache breakpoints carried over from a prior call's persisted input
  // so we never accumulate past the API's 4-breakpoint limit (we add exactly one
  // fresh breakpoint below).
  const messages: ThreadMessage[] = stripCacheControl(thread.messages);

  // Fresh thread → orient it (core memory + last diary) so a (re)started agent
  // picks up its life rather than booting cold. One-time, folded into this input.
  let firstInput = inputText;
  if (messages.length === 0) {
    const seed = await buildSeedContext(agentId);
    firstInput = `${seed}\n\n---\n\n${inputText}`;
  }

  // Cache breakpoint on the new input's block: this turn WRITES the cache up
  // through the input, and the next turn READS the whole thread prefix as a hit.
  // That is what keeps a long continuous thread economical (plan §6.4) — at our
  // 11–15 min cadence the 1h ephemeral TTL stays warm between turns. We strip it
  // before persisting so the stored thread stays clean.
  messages.push({
    role: "user",
    content: [
      { type: "text", text: firstInput, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  });

  let rounds = 0;
  let totalCost = 0;
  let totalCacheRead = 0;
  let refused = false;
  let finalText = "";

  const runner = anthropic.beta.messages.toolRunner({
    model,
    max_tokens: maxTokens,
    system: systemBlocks(agentId),
    messages,
    tools,
    max_iterations: MAX_TURN_ROUNDS,
    betas: [...LOOP_BETAS],
    context_management: COMPACTION,
  });

  for await (const message of runner) {
    rounds++;
    const t = tokensFromUsage(message.usage);
    const cost = estimateCostUsd(model, t);
    totalCost += cost;
    totalCacheRead += t.cacheReadTokens;
    await recordUsage({
      agentId,
      model,
      tickId,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estCostUsd: cost,
    });
    trace.event("round", {
      round: rounds,
      stop_reason: message.stop_reason,
      cache_read_input_tokens: t.cacheReadTokens,
      cost,
    });
    // Refusal handling (explicit). Stop the turn; don't retry.
    if (message.stop_reason === "refusal") {
      refused = true;
      break;
    }
    const text = extractText(message);
    if (text && message.stop_reason === "end_turn") finalText = text;
  }

  // Persist the accumulated thread (incl. any compaction blocks) — only reached
  // when the loop ran to completion. Strip the runtime cache breakpoint first.
  const cursor =
    opts.advanceCursorTo === undefined ? thread.inputCursor : opts.advanceCursorTo;
  await persistThread(agentId, stripCacheControl(runner.params.messages), cursor);

  return { rounds, totalCost, totalCacheRead, refused, finalText };
}

// Run one idle tick for an agent on its continuous thread. Safe to call from the
// scheduler or the /admin/tick endpoint. Never throws — returns a structured
// result.
export async function runTick(agentId: AgentId): Promise<TickResult> {
  if (!hasLlm()) return { ran: false, reason: "no-llm" };

  // Serialize against any other turn for this agent in this process (scheduler
  // timer vs POST /admin/tick, reflection, etc). If we can't take the lock,
  // another turn is mid-flight.
  const release = tryAcquire(agentId);
  if (!release) return { ran: false, reason: "busy" };
  try {
    return await runTickLocked(agentId);
  } finally {
    release();
  }
}

async function runTickLocked(agentId: AgentId): Promise<TickResult> {
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };
  // Engaged in a live chat/scene → skip the idle tick (logged distinctly).
  if (isBusy(agent.engagement)) {
    console.log(`[tick ${agentId}] skipped — engaged:${agent.engagement!.kind}.`);
    return { ran: false, reason: "busy" };
  }

  // Budget gates: global hard ceiling + per-role soft cap. Either trips → status
  // "sleeping (budget)" and the scheduler skips until UTC midnight.
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
    // Emit an activity line on the transition INTO budget-sleep so the feed
    // distinguishes "hit its cap" from "silently stopped ticking (crashed)".
    if (agent.status !== SLEEPING_BUDGET) {
      await setStatus(agentId, SLEEPING_BUDGET);
      await setActivity(agentId, "resting — out of energy for today");
    }
    return { ran: false, reason: "budget" };
  }
  // Coming back from a budget sleep on a new day: clear the status.
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

  // The world delta (pure SQL, push/pull model): standing state + notice-push
  // since the last input, self-events and elsewhere-events excluded. APPENDED to
  // the continuous thread as the tick input — not a from-scratch prompt.
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

  // Advance the perception cursor + last_tick_at so the next tick sees only newer
  // events, and mark delivered inbox messages read. (Done after a successful turn.)
  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);
  // A lived tick clears the seed's "settling in" status.
  if (agent.status !== "awake") await setStatus(agentId, "awake");

  // Persist any public-safe assistant text as a thought (PUBLIC: the protocol
  // frames thoughts as public-safe performance — thought bubbles are the point).
  if (outcome.finalText && !outcome.refused) {
    await appendEvent({
      type: "agent.thought",
      agentId,
      locationId: ctx.location,
      visibility: "public",
      payload: { agent: agentId, text: outcome.finalText.slice(0, 600) },
    });
  }

  trace.end({
    rounds: outcome.rounds,
    totalCost: outcome.totalCost,
    totalCacheRead: outcome.totalCacheRead,
    refused: outcome.refused,
  });

  // Unconditional structured tick line so the soak's cache-hygiene check
  // (cache_read_input_tokens > 0) is observable WITHOUT Langfuse.
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

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Remove cache_control from every content block so a persisted thread carries no
// breakpoints (we add exactly one fresh breakpoint per call; persisting them
// would accumulate past the API's 4-breakpoint limit). Setting it to undefined
// is dropped by JSON.stringify on persist, so the stored thread stays clean.
function stripCacheControl(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const content = m.content.map((b) =>
      "cache_control" in b && b.cache_control != null ? { ...b, cache_control: undefined } : b,
    );
    return { ...m, content };
  });
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
