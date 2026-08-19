import type Anthropic from "@anthropic-ai/sdk";
import { tokensFromUsage } from "../../pricing.js";
import type { LlmEndpoint, NormalizedUsage } from "../types.js";

export function normalizeAnthropicUsage(
  model: string,
  usage: Anthropic.Beta.BetaUsage,
  endpoint: LlmEndpoint,
  round?: number,
  stopReason?: string | null,
): NormalizedUsage {
  const tokens = tokensFromUsage(usage);
  return {
    provider: "anthropic",
    model,
    endpoint,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    round,
    stopReason,
  };
}
