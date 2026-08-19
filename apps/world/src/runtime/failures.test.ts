// Provider-neutral failure scheduling + the circuit breaker. Vendor message
// signatures are tested with their adapters, not duplicated here.

import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  isCircuitBroken,
  circuitBroken,
  backoffMs,
  CIRCUIT_BREAK_AFTER,
} from "./failures.js";
import type { ProviderError } from "./llm/types.js";

function providerError(overrides: Partial<ProviderError> = {}): ProviderError {
  return {
    provider: "openai",
    kind: "provider",
    retryable: true,
    threadCorrupt: false,
    status: 503,
    message: "temporarily unavailable",
    ...overrides,
  };
}

describe("classifyFailure", () => {
  it("maps retryability without knowing vendor status/message signatures", () => {
    const f = classifyFailure(providerError());
    expect(f.provider).toBe("openai");
    expect(f.errorKind).toBe("provider");
    expect(f.kind).toBe("transient");
    expect(f.retryable).toBe(true);
  });

  it("keeps authentication and credit errors permanent without corrupting a thread", () => {
    const f = classifyFailure(
      providerError({ kind: "authentication", retryable: false, status: 401 }),
    );
    expect(f.kind).toBe("permanent");
    expect(f.threadCorrupt).toBe(false);
  });

  it("preserves the adapter's explicit native-thread corruption signal", () => {
    const f = classifyFailure(
      providerError({ kind: "thread_corrupt", retryable: false, threadCorrupt: true, status: 400 }),
    );
    expect(f.kind).toBe("permanent");
    expect(f.threadCorrupt).toBe(true);
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
