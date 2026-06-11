// Per-model token pricing (USD per 1M tokens) for the budget meter. Sourced
// from the claude-api skill's model table (cached 2026-06). Cache reads are
// ~0.1x base input; cache writes (1h TTL) are ~2x base input — we use those
// multipliers so the llm_usage est_cost reflects the cache-aware spend the
// soak's budget cap enforces.

interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5 },
};

// Fallback for an unknown model id — assume Haiku-tier so we never crash a
// tick on a pricing miss; the warning surfaces in the usage row's est cost.
const FALLBACK: ModelPrice = { inputPerM: 1, outputPerM: 5 };

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Estimate USD cost of one call. cache_read ≈ 0.1x input price; cache_write
// (1h TTL) ≈ 2x input price; `inputTokens` here is the uncached remainder.
export function estimateCostUsd(model: string, t: UsageTokens): number {
  const p = PRICES[model] ?? FALLBACK;
  const inUncached = (t.inputTokens / 1_000_000) * p.inputPerM;
  const inCacheRead = (t.cacheReadTokens / 1_000_000) * p.inputPerM * 0.1;
  const inCacheWrite = (t.cacheWriteTokens / 1_000_000) * p.inputPerM * 2;
  const out = (t.outputTokens / 1_000_000) * p.outputPerM;
  return inUncached + inCacheRead + inCacheWrite + out;
}

// Pull the four token counts out of an Anthropic usage object (which uses
// snake_case and may omit the cache fields).
export function tokensFromUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageTokens {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}
