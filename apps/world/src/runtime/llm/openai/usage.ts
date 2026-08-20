import type { LlmEndpoint, NormalizedUsage } from "../types.js";

export interface OpenAIRequestUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokensDetails?: Record<string, number>;
  endpoint?: string;
}

export interface OpenAIRunUsageLike extends OpenAIRequestUsageLike {
  requestUsageEntries?: OpenAIRequestUsageLike[];
}

function cachedTokens(details: Record<string, number> | undefined): number {
  return details?.cached_tokens ?? details?.cachedTokens ?? 0;
}

function normalizeEndpoint(endpoint: string | undefined, fallback: LlmEndpoint): LlmEndpoint {
  return endpoint === "responses.compact" ? "compact" : fallback;
}

export function normalizeOpenAIRequestUsage(
  model: string,
  usage: OpenAIRequestUsageLike,
  fallbackEndpoint: LlmEndpoint,
  round?: number,
): NormalizedUsage {
  const cacheReadTokens = cachedTokens(usage.inputTokensDetails);
  return {
    provider: "openai",
    model,
    endpoint: normalizeEndpoint(usage.endpoint, fallbackEndpoint),
    // OpenAI's input token total includes the cached portion. The town's
    // normalized inputTokens field means uncached input so pricing cannot
    // double-charge cache reads.
    inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens: 0,
    round,
    stopReason: null,
  };
}

export function normalizeOpenAIRunUsage(
  model: string,
  usage: OpenAIRunUsageLike,
  fallbackEndpoint: LlmEndpoint,
): NormalizedUsage[] {
  const entries = usage.requestUsageEntries?.length ? usage.requestUsageEntries : [usage];
  let turnRound = 0;
  return entries.map((entry) => {
    const endpoint = normalizeEndpoint(entry.endpoint, fallbackEndpoint);
    const round = endpoint === "turn" ? ++turnRound : undefined;
    return normalizeOpenAIRequestUsage(model, entry, fallbackEndpoint, round);
  });
}

export function normalizeOpenAIResponseUsage(
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
  } | null | undefined,
  endpoint: LlmEndpoint,
): NormalizedUsage {
  return normalizeOpenAIRequestUsage(
    model,
    {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      inputTokensDetails: {
        cached_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    },
    endpoint,
    1,
  );
}
