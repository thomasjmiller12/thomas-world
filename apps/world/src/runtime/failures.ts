// Turn-failure classification + the circuit breaker (2026-07-30).
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

/** How a failure should be treated by the scheduler/loop. */
export type FailureKind =
  // The request will never succeed as-is (bad key, no credits, malformed
  // thread). Retrying is pure waste — circuit-break and surface it.
  | "permanent"
  // Rate limit / overload / network blip. Back off, then keep going.
  | "transient";

export interface ClassifiedFailure {
  kind: FailureKind;
  /** True when the message points at the thread itself rather than the account. */
  threadPoisoned: boolean;
  status?: number;
  message: string;
}

// Consecutive failures before we stop scheduling an agent at all. Deliberately
// small: a permanently-failing agent is a dead agent, and we would rather know
// within an hour than a month.
export const CIRCUIT_BREAK_AFTER = 4;

// Consecutive failures before we try reseeding the thread. Lower than the
// breaker so self-healing gets a shot BEFORE we give up on the agent — a
// poisoned thread is the one permanent failure we can actually fix ourselves.
export const RESEED_AFTER = 3;

// Signatures of a request that can never succeed by being re-sent. The
// thinking-block one is the Researcher poisoning verbatim.
const POISONED_THREAD_PATTERNS = [
  /`?thinking`? or `?redacted_thinking`? blocks/i,
  /blocks in the latest assistant message cannot be modified/i,
  /`?tool_use`? ids were found without `?tool_result`?/i,
  /`?compaction`? blocks require/i,
  /unexpected `?tool_use_id`? found/i,
];

const PERMANENT_PATTERNS = [
  /credit balance is too low/i,
  /invalid[ _]request[ _]error/i,
  /authentication[ _]error/i,
  /permission[ _]error/i,
  /not[ _]found[ _]error/i,
  /request too large/i,
];

// Pull an HTTP status off whatever the SDK threw (it exposes `status`; a raw
// fetch failure has none).
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Classify a thrown turn error. Defaults to TRANSIENT when unsure — we would
 * rather retry a genuinely-broken agent a few extra times than silently stop
 * ticking a healthy one on a misread error string.
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  const message = (err as Error)?.message ?? String(err);
  const status = statusOf(err);

  const threadPoisoned = POISONED_THREAD_PATTERNS.some((re) => re.test(message));
  if (threadPoisoned) return { kind: "permanent", threadPoisoned: true, status, message };

  // 429 (rate limit) and 529 (overloaded) are explicitly retryable even though
  // they are 4xx/5xx; check them before the generic 4xx rule below.
  if (status === 429 || status === 529) {
    return { kind: "transient", threadPoisoned: false, status, message };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "transient", threadPoisoned: false, status, message };
  }
  if (PERMANENT_PATTERNS.some((re) => re.test(message))) {
    return { kind: "permanent", threadPoisoned: false, status, message };
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413) {
    return { kind: "permanent", threadPoisoned: false, status, message };
  }
  return { kind: "transient", threadPoisoned: false, status, message };
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
