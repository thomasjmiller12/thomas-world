// What we DO about a failed turn: record it, self-heal a poisoned thread, and
// circuit-break an agent that is permanently broken.
//
// Kept separate from both `failures.ts` (pure classification, no DB — so its
// tests need no mocks) and `loop.ts` (which imports reflection.ts, so reflection
// importing the loop would be a cycle). Every turn-runner — ticks, visitor turns,
// reflection — funnels its catch block through here so no failure path can
// silently swallow an agent's death again.

import type { AgentId } from "@town/contract";
import { markTurnFailed, clearFailures, setStatus } from "../engine/agents.js";
import { reseedThread } from "../engine/thread.js";
import { classifyFailure, isCircuitBroken, RESEED_AFTER } from "./failures.js";

export type TurnKind = "tick" | "visitor" | "reflection";

/**
 * Record a failed turn and act on the streak.
 *
 * Two behaviours, both missing when Researcher Thomas died silently for 27 days:
 *
 *  1. SELF-HEAL a poisoned thread. The thread is replayed on every turn, so one
 *     un-replayable message fails deterministically forever. `reseedThread`
 *     existed and was designed for exactly this, but nothing ever called it.
 *  2. CIRCUIT-BREAK. Past CIRCUIT_BREAK_AFTER the scheduler stops enqueuing for
 *     this agent, so a dead API key isn't retried ~10x/hour/agent for 11 hours,
 *     and /health goes red instead of cheerfully reporting {ok:true}.
 *
 * Never throws — a failure in the failure handler must not mask the original.
 */
export async function recordTurnFailure(
  agentId: AgentId,
  err: unknown,
  kind: TurnKind,
): Promise<void> {
  const failure = classifyFailure(err);
  const n = await markTurnFailed(agentId, failure.message).catch(() => 0);
  console.warn(
    `[${kind} ${agentId}] ${failure.kind} failure #${n}` +
      `${failure.status ? ` (http ${failure.status})` : ""}` +
      `${failure.threadPoisoned ? " THREAD-POISONED" : ""}: ${failure.message.slice(0, 300)}`,
  );

  // A poisoned thread is the one permanent failure we can repair ourselves, and
  // it never fixes itself, so don't wait for the streak.
  const shouldReseed =
    failure.threadPoisoned || (failure.kind === "permanent" && n >= RESEED_AFTER);
  if (shouldReseed) {
    try {
      await reseedThread(agentId);
      // Clear the streak so the repaired agent gets a clean run rather than
      // tripping the breaker on failures that predate the repair.
      await clearFailures(agentId);
      console.warn(
        `[${kind} ${agentId}] thread RESEEDED from core memory + last diary after ` +
          `${failure.threadPoisoned ? "a poisoned-thread error" : `${n} permanent failures`}.`,
      );
      return;
    } catch (reseedErr) {
      console.error(
        `[${kind} ${agentId}] reseed FAILED — agent needs manual repair:`,
        (reseedErr as Error).message,
      );
    }
  }

  if (isCircuitBroken(n)) {
    console.error(
      `[${kind} ${agentId}] CIRCUIT BROKEN after ${n} consecutive failures — ` +
        `no longer scheduling this agent. Last error: ${failure.message.slice(0, 300)}`,
    );
    // Surfaced in the agent's own status so /debug and the snapshot stop
    // presenting a dead agent as "awake".
    await setStatus(agentId, `broken (${n} failures)`).catch(() => {});
  }
}
