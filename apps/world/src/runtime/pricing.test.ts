import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./pricing.js";

describe("pricing — token cost estimation", () => {
  it("prices Haiku input/output at $1/$5 per MTok", () => {
    const cost = estimateCostUsd("anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(1, 6);
    const out = estimateCostUsd("anthropic", "claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(out).toBeCloseTo(5, 6);
  });

  it("prices Opus input/output at $5/$25 per MTok", () => {
    const cost = estimateCostUsd("anthropic", "claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(30, 6);
  });

  it("charges cache reads at ~0.1x input and 1h writes at ~2x input", () => {
    const read = estimateCostUsd("anthropic", "claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(read).toBeCloseTo(0.1, 6);
    const write = estimateCostUsd("anthropic", "claude-haiku-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(2, 6);
  });

  it("prices gpt-5.4 input, cached input, and output at the provider rate", () => {
    const cost = estimateCostUsd("openai", "gpt-5.4", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(17.75, 6);
  });

  it("fails closed for an unknown active provider/model pair", () => {
    expect(() =>
      estimateCostUsd("openai", "some-future-model", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toThrow(/No pricing configured/);
  });
});
