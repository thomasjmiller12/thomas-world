import { describe, it, expect } from "vitest";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";

describe("pricing — token cost estimation", () => {
  it("prices Haiku input/output at $1/$5 per MTok", () => {
    const cost = estimateCostUsd("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1, 6);
    const out = estimateCostUsd("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(out).toBeCloseTo(5, 6);
  });

  it("prices Opus input/output at $5/$25 per MTok", () => {
    const cost = estimateCostUsd("claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(30, 6);
  });

  it("charges cache reads at ~0.1x input and 1h writes at ~2x input", () => {
    const read = estimateCostUsd("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(read).toBeCloseTo(0.1, 6);
    const write = estimateCostUsd("claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(2, 6);
  });

  it("falls back to Haiku-tier pricing for an unknown model (never crashes)", () => {
    const cost = estimateCostUsd("some-future-model", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1, 6);
  });

  it("maps an Anthropic usage object (snake_case, nullable cache fields)", () => {
    const t = tokensFromUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: null,
    });
    expect(t).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });
});
