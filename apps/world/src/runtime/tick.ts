// The tick runner (plan §4.1). One tick = one trace. Builds the observation
// packet (pure SQL), assembles the cached prefix + frozen core-memory + current
// observation, and runs the SDK toolRunner for bounded rounds. Persists usage
// with cache_read tokens, records the daily budget, handles refusal, and
// advances the perception cursor + last_tick_at.
//
// We DO NOT hand-roll the dispatch loop — the SDK's toolRunner owns it; we bound
// it by iterating (max_iterations) and inspecting each yielded BetaMessage.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AgentId } from "@town/contract";
import { config } from "../config.js";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS } from "./client.js";
import { getProfile, soulGitHash } from "./roles.js";
import { buildTools, type AgentContext } from "./tools.js";
import { buildObservation, writeCursor } from "./observation.js";
import { coreMemorySnapshot } from "../engine/memory.js";
import { getAgent, setStatus, setActivity, markTicked, isBusy } from "../engine/agents.js";
import { appendEvent } from "../engine/events.js";
import { markRead } from "../engine/messages.js";
import { recordUsage, spendTodayUsd, spendTodayForAgent } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { startTrace } from "./tracing.js";
import { tryAcquire } from "./agent-lock.js";

// How many tool rounds a single idle tick may take before we force a stop.
const MAX_TICK_ROUNDS = 6;
export const SLEEPING_BUDGET = "sleeping (budget)";

// Pure budget-cap decision (brief §"Observability & budget"): a tick is blocked
// when either the global daily ceiling OR the agent's per-role soft cap is met.
// Extracted so it's unit-testable without a DB or the LLM.
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
  // Langfuse trace id for this tick (empty when tracing is off). Surfaced by the
  // /admin/tick endpoint so a smoke test can verify the trace landed.
  traceId?: string;
}

// Run one idle tick for an agent. Safe to call from the scheduler or the
// /admin/tick endpoint. Never throws — returns a structured result.
export async function runTick(agentId: AgentId): Promise<TickResult> {
  if (!hasLlm()) return { ran: false, reason: "no-llm" };

  // Serialize against any other tick/reflection for this agent in this process
  // (scheduler timer vs POST /admin/tick, etc). The DB `busy` flag does NOT
  // cover tick-vs-tick. If we can't take the lock, another tick is mid-flight.
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
  // Engaged in a live chat/scene (design doc §3.2) → skip the idle tick. The
  // scheduler logs this as a distinct, visible reason rather than silently.
  if (isBusy(agent.engagement)) {
    console.log(`[tick ${agentId}] skipped — engaged:${agent.engagement!.kind}.`);
    return { ran: false, reason: "busy" };
  }

  // Budget gates (brief): global hard ceiling + per-role soft cap. Either trips
  // → status "sleeping (budget)" and the scheduler skips until UTC midnight.
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
    // distinguishes "went quiet because it hit its cap" from "silently stopped
    // ticking (crashed)" — they look identical to a log reviewer otherwise.
    if (agent.status !== SLEEPING_BUDGET) {
      await setStatus(agentId, SLEEPING_BUDGET);
      await setActivity(agentId, "resting — out of energy for today");
    }
    return { ran: false, reason: "budget" };
  }
  // Coming back from a budget sleep on a new day: clear the status (the activity
  // line emits a "back at it" so the wake-up is visible in the feed too).
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

  // 1. Observation packet — pure SQL, frozen for this tick. Core memory is
  //    snapshotted here so it's byte-stable for the request (below the cache
  //    breakpoint, per plan §4.3).
  const obs = await buildObservation(agentId, { cadenceMinutes: profile.role.tickCadenceMinutes });
  const core = await coreMemorySnapshot(agentId); // also embedded in obs; harmless dup avoided below

  void core; // obs.text already includes the core snapshot.

  const ctx: AgentContext = { agentId, location: obs.location };
  const tools = buildTools(ctx);

  // 2. The user turn carries the volatile content (time + observation). The
  //    soul + protocol live in the cached system blocks (byte-stable).
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: obs.text },
  ];

  // 3. Run the SDK agentic loop, bounded. We iterate the runner ourselves so we
  //    can (a) cap rounds, (b) inspect stop_reason for refusal, and (c) sum
  //    usage across rounds.
  let rounds = 0;
  let totalCost = 0;
  let totalCacheRead = 0;
  let refused = false;

  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: profile.role.tickModel,
      max_tokens: 4096,
      system: systemBlocks(agentId),
      messages,
      tools,
      max_iterations: MAX_TICK_ROUNDS,
      betas: [...TICK_BETAS],
    });

    for await (const message of runner) {
      rounds++;
      // Usage accounting per round (plan §4.1 step 4 + brief budget/cache).
      const t = tokensFromUsage(message.usage);
      const cost = estimateCostUsd(profile.role.tickModel, t);
      totalCost += cost;
      totalCacheRead += t.cacheReadTokens;
      await recordUsage({
        agentId,
        model: profile.role.tickModel,
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

      // Refusal handling (explicit, plan §4.1). Stop the tick; don't retry.
      if (message.stop_reason === "refusal") {
        refused = true;
        break;
      }

      // Persist any public-safe assistant text as a thought. PUBLIC (design doc
      // §5): the protocol frames thoughts as public-safe performance — thought
      // bubbles are the point of the surface — so they materialize on the feed
      // and over sprites. (Truly private cognition simply isn't emitted.)
      const text = extractText(message);
      if (text && message.stop_reason === "end_turn") {
        await appendEvent({
          type: "agent.thought",
          agentId,
          locationId: ctx.location,
          visibility: "public",
          payload: { agent: agentId, text: text.slice(0, 600) },
        });
      }
    }
  } catch (err) {
    console.warn(`[tick ${agentId}] error:`, (err as Error).message);
    trace.end({ error: (err as Error).message });
    await markTicked(agentId);
    return { ran: false, reason: "error", rounds, traceId: trace.traceId };
  }

  // 4. Advance the perception cursor + last_tick_at so the next tick sees only
  //    newer events, and mark delivered inbox messages read.
  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);
  // Status carries coarse liveness only (activity is the expressive line); a
  // lived tick clears the seed's "settling in" — which otherwise persisted
  // forever, since nothing but budget transitions ever wrote status.
  if (agent.status !== "awake") await setStatus(agentId, "awake");

  trace.end({ rounds, totalCost, totalCacheRead, refused });

  // Unconditional structured tick line so the soak's cache-hygiene check
  // (`cache_read_input_tokens > 0`) is observable WITHOUT Langfuse — the soak
  // runs with tracing off, and the brief requires tick logs surface cache reads.
  console.log(
    `[tick ${agentId}] rounds=${rounds} cacheRead=${totalCacheRead} cost=$${totalCost.toFixed(4)}${
      refused ? " refused" : ""
    }`,
  );

  return {
    ran: true,
    reason: refused ? "refusal" : "ok",
    rounds,
    costUsd: totalCost,
    cacheReadTokens: totalCacheRead,
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

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
