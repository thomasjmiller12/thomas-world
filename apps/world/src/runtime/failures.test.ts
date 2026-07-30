// Failure classification + the circuit breaker. These encode the two real
// incidents from 2026-07-30 (see failures.ts header): an 11-hour out-of-credits
// window that was retried at full cadence, and Researcher's 27-day poisoned
// thread that nothing noticed.

import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  isCircuitBroken,
  circuitBroken,
  backoffMs,
  CIRCUIT_BREAK_AFTER,
} from "./failures.js";

// The SDK throws errors carrying a numeric `status`.
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyFailure", () => {
  it("treats the real out-of-credits 400 as permanent", () => {
    const f = classifyFailure(
      apiError(
        400,
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      ),
    );
    expect(f.kind).toBe("permanent");
    // The account is broken, not the thread — reseeding would be wrong here.
    expect(f.threadPoisoned).toBe(false);
  });

  it("flags the real thinking-block error as a POISONED THREAD", () => {
    // Verbatim from the Researcher incident.
    const f = classifyFailure(
      apiError(
        400,
        "400 messages.305.content.16: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
      ),
    );
    expect(f.kind).toBe("permanent");
    expect(f.threadPoisoned).toBe(true);
  });

  it("flags orphaned tool_use as a poisoned thread", () => {
    const f = classifyFailure(
      apiError(400, "messages.1006: `tool_use` ids were found without `tool_result` blocks"),
    );
    expect(f.threadPoisoned).toBe(true);
  });

  it("flags a compaction-strategy mismatch as a poisoned thread", () => {
    const f = classifyFailure(
      apiError(400, "messages.79.content.0: `compaction` blocks require a `compact_20260112` strategy"),
    );
    expect(f.threadPoisoned).toBe(true);
  });

  it("treats rate limits and overload as transient, not permanent", () => {
    expect(classifyFailure(apiError(429, "rate_limit_error")).kind).toBe("transient");
    expect(classifyFailure(apiError(529, "overloaded_error")).kind).toBe("transient");
  });

  it("treats 5xx and bare network errors as transient", () => {
    expect(classifyFailure(apiError(500, "internal")).kind).toBe("transient");
    expect(classifyFailure(apiError(503, "unavailable")).kind).toBe("transient");
    expect(classifyFailure(new Error("socket hang up")).kind).toBe("transient");
  });

  it("treats auth failures as permanent", () => {
    expect(classifyFailure(apiError(401, "authentication_error")).kind).toBe("permanent");
    expect(classifyFailure(apiError(403, "permission_error")).kind).toBe("permanent");
  });

  it("defaults to transient when the error is unrecognizable", () => {
    // Better to retry a broken agent a few extra times than to silently stop
    // ticking a healthy one on a misread string.
    expect(classifyFailure(new Error("something weird")).kind).toBe("transient");
    expect(classifyFailure(undefined).kind).toBe("transient");
  });
});

describe("circuit breaker", () => {
  it("stays closed below the threshold and opens at it", () => {
    expect(isCircuitBroken(CIRCUIT_BREAK_AFTER - 1)).toBe(false);
    expect(isCircuitBroken(CIRCUIT_BREAK_AFTER)).toBe(true);
  });

  it("tolerates null/undefined straight off an agent row", () => {
    expect(circuitBroken(null)).toBe(false);
    expect(circuitBroken(undefined)).toBe(false);
    expect(circuitBroken(CIRCUIT_BREAK_AFTER + 5)).toBe(true);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and caps at 30 minutes", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(50)).toBe(30 * 60_000);
  });

  it("never returns less than the first step", () => {
    expect(backoffMs(0)).toBe(60_000);
  });
});
