import type { LlmProviderName } from "./types.js";
import { config } from "../../config.js";
import type { TownTool } from "./tool.js";
import type { LlmProvider } from "./types.js";
import { anthropicProvider } from "./anthropic/provider.js";
import { openaiProvider } from "./openai/provider.js";

export interface ProviderCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export type ProviderConfiguration =
  | { configured: true }
  | { configured: false; missingEnv: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" };

export function providerConfiguration(
  provider: LlmProviderName,
  credentials: ProviderCredentials,
): ProviderConfiguration {
  if (provider === "anthropic") {
    return credentials.anthropicApiKey
      ? { configured: true }
      : { configured: false, missingEnv: "ANTHROPIC_API_KEY" };
  }
  return credentials.openaiApiKey
    ? { configured: true }
    : { configured: false, missingEnv: "OPENAI_API_KEY" };
}

export function getLlmProvider(provider: LlmProviderName): LlmProvider<TownTool> {
  if (provider === "anthropic") return anthropicProvider;
  return openaiProvider;
}

export function getActiveLlmProvider(): LlmProvider<TownTool> {
  return getLlmProvider(config.llmProvider);
}

export function activeProviderConfiguration(): ProviderConfiguration {
  return providerConfiguration(config.llmProvider, {
    anthropicApiKey: config.anthropicApiKey,
    openaiApiKey: config.openaiApiKey,
  });
}

export function hasLlm(): boolean {
  return activeProviderConfiguration().configured;
}
