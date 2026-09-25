// Provider-neutral turn-failure scheduling + the circuit breaker (2026-07-30).
//
// Two real incidents motivate this module, and they need OPPOSITE handling:
//
//  1. Out of credits (2026-07-26 → 07-30). Every turn 400'd with
//     invalid_request_error for ~11 hours. The loop retried at full cadence the
//     whole time — a request that can never succeed, re-sent ~10x/hour/agent.
//  2. Poisoned thread (Researcher, 2026-07-03 → 07-30). One assistant message
//     held two consecutive `thinking` blocks, which the API refuses to replay.
//     Deterministic 400 on every turn for 27 days, with nothing to notice it.
//
// A PERMANENT failure must stop being retried and become loud. A TRANSIENT one
// (429/5xx/network) should back off and keep trying. Previously both were a bare
// `console.warn` and an immediate reschedule.

import type { ProviderError } from "./llm/types.js";

/** How a normalized provider failure should be treated by the scheduler/loop. */
export type FailureKind =
  // The request will never succeed as-is (bad key, no credits, malformed
  // thread). Retrying is pure waste — circuit-break and surface it.
  | "permanent"
  // Rate limit / overload / network blip. Back off, then keep going.
  | "transient";

export interface ClassifiedFailure {
  provider: ProviderError["provider"];
  errorKind: string;
  kind: FailureKind;
  retryable: boolean;
  /** True only when the selected provider says replaying this native thread is invalid. */
  threadCorrupt: boolean;
  status?: number;
  message: string;
}

// Consecutive failures before we stop scheduling an agent at all. Deliberately
// small: a permanently-failing agent is a dead agent, and we would rather know
// within an hour than a month.
export const CIRCUIT_BREAK_AFTER = 4;

/**
 * Translate a provider adapter's normalized error into scheduling semantics.
 * Vendor status codes and message signatures belong in the adapters; this
 * module only decides whether to retry/back off and when to open the circuit.
 */
export function classifyFailure(error: ProviderError): ClassifiedFailure {
  return {
    provider: error.provider,
    errorKind: error.kind,
    kind: error.retryable ? "transient" : "permanent",
    retryable: error.retryable,
    threadCorrupt: error.threadCorrupt,
    status: error.status,
    message: error.message,
  };
}

/** True when this agent has failed enough consecutive turns to stop scheduling it. */
export function isCircuitBroken(consecutiveFailures: number): boolean {
  return consecutiveFailures >= CIRCUIT_BREAK_AFTER;
}

/** Nullable-tolerant form for callers reading straight off an agent row. */
export function circuitBroken(consecutiveFailures: number | null | undefined): boolean {
  return isCircuitBroken(consecutiveFailures ?? 0);
}

/** Backoff for a transient failure: 1m, 2m, 4m, 8m … capped at 30m. */
export function backoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(30 * 60_000, 60_000 * 2 ** (n - 1));
}
