import OpenAI from "openai";
import {
  MemorySession,
  OpenAIProvider,
  OpenAIResponsesCompactionSession,
  Runner,
  type AgentInputItem,
} from "@openai/agents";
import { config } from "../../../config.js";

// The OpenAI client throws during construction when no key exists. Use a
// non-secret inert value so env-gated Anthropic-only boots and tests can still
// import the provider registry; isConfigured() prevents real requests.
export const openaiClient = new OpenAI({
  apiKey: config.openaiApiKey ?? "not-configured",
});

export const openaiModelProvider = new OpenAIProvider({
  openAIClient: openaiClient,
  useResponses: true,
});

export const openaiRunner = new Runner({
  modelProvider: openaiModelProvider,
  // The town already owns tracing through runtime/tracing.ts + Langfuse OTel.
  tracingDisabled: true,
});

const COMPACT_TRIGGER_TOKENS = 50_000;

function approximateRenderedTokens(items: readonly AgentInputItem[]): number {
  return Math.ceil(JSON.stringify(items).length / 4);
}

export function createOpenAISession(
  initialItems: AgentInputItem[],
  model: string,
): OpenAIResponsesCompactionSession {
  const memory = new MemorySession({ initialItems });
  return new OpenAIResponsesCompactionSession({
    client: openaiClient,
    underlyingSession: memory,
    model,
    compactionMode: "input",
    shouldTriggerCompaction: ({ sessionItems }) =>
      approximateRenderedTokens(sessionItems) >= COMPACT_TRIGGER_TOKENS,
  });
}

export const OPENAI_CONTEXT_MANAGEMENT = [
  { type: "compaction", compactThreshold: COMPACT_TRIGGER_TOKENS },
] as const;
