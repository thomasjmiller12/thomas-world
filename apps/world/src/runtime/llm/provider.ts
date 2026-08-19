import type { LlmProviderName } from "./types.js";

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
