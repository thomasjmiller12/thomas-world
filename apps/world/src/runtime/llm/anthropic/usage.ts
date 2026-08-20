import type { LlmEndpoint, NormalizedUsage } from "../types.js";

export interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function normalizeAnthropicUsage(
  model: string,
  usage: AnthropicUsageLike,
  endpoint: LlmEndpoint,
  round?: number,
  stopReason?: string | null,
): NormalizedUsage {
  return {
    provider: "anthropic",
    model,
    endpoint,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    round,
    stopReason,
  };
}
