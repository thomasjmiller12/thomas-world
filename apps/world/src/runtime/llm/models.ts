import type { LlmProviderName, ModelRef } from "./types.js";

export type SystemModelWorkload = "chronicle" | "townCrier";

const SYSTEM_MODELS: Record<SystemModelWorkload, Record<LlmProviderName, string>> = {
  chronicle: {
    anthropic: "claude-haiku-4-5",
    openai: "gpt-5.4",
  },
  townCrier: {
    anthropic: "claude-sonnet-5",
    openai: "gpt-5.4",
  },
};

export function resolveSystemModel(
  workload: SystemModelWorkload,
  provider: LlmProviderName,
): ModelRef {
  return { provider, model: SYSTEM_MODELS[workload][provider] };
}
