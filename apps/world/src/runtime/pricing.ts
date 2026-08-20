// Per-provider/model token pricing (USD per 1M tokens) for the budget meter.
// Provider is part of the key deliberately: model ids are not a global
// namespace, and a missing active price must be loud rather than silently
// under-counting the daily budget.

import type { LlmProviderName } from "./llm/types.js";

interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

const PRICES: Record<LlmProviderName, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-opus-4-8": {
      inputPerM: 5,
      outputPerM: 25,
      cacheReadPerM: 0.5,
      cacheWritePerM: 10,
    },
    // Sonnet 5 sticker is $3/$15 (intro $2/$10 through 2026-08-31). We meter at the
    // sticker rate so the budget cap never under-counts when intro pricing lapses.
    "claude-sonnet-5": {
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheWritePerM: 6,
    },
    "claude-sonnet-4-6": {
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
      cacheWritePerM: 6,
    },
    "claude-haiku-4-5": {
      inputPerM: 1,
      outputPerM: 5,
      cacheReadPerM: 0.1,
      cacheWritePerM: 2,
    },
  },
  openai: {
    "gpt-5.4": { inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25, cacheWritePerM: 0 },
    "gpt-5.4-mini": { inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075, cacheWritePerM: 0 },
  },
};

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateCostUsd(
  provider: LlmProviderName,
  model: string,
  t: UsageTokens,
): number {
  const p = PRICES[provider][model];
  if (!p) throw new Error(`No pricing configured for ${provider}/${model}`);
  const inUncached = (t.inputTokens / 1_000_000) * p.inputPerM;
  const inCacheRead = (t.cacheReadTokens / 1_000_000) * p.cacheReadPerM;
  const inCacheWrite = (t.cacheWriteTokens / 1_000_000) * p.cacheWritePerM;
  const out = (t.outputTokens / 1_000_000) * p.outputPerM;
  return inUncached + inCacheRead + inCacheWrite + out;
}
