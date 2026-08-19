import type { AgentId, ChatStreamFrame } from "@town/contract";

export const llmProviderNames = ["anthropic", "openai"] as const;
export type LlmProviderName = (typeof llmProviderNames)[number];

export function parseLlmProvider(value: string | undefined): LlmProviderName {
  if (value == null || value === "") return "anthropic";
  if ((llmProviderNames as readonly string[]).includes(value)) {
    return value as LlmProviderName;
  }
  throw new Error(
    `LLM_PROVIDER must be one of: ${llmProviderNames.join(", ")} (received ${JSON.stringify(value)})`,
  );
}

export interface ModelRef {
  provider: LlmProviderName;
  model: string;
}

export interface NativeThreadState {
  provider: LlmProviderName;
  items: unknown[];
}

export type LlmEndpoint = "turn" | "compact" | "generate";

export interface NormalizedUsage {
  provider: LlmProviderName;
  model: string;
  endpoint: LlmEndpoint;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  round?: number;
  stopReason?: string | null;
}

export interface ProviderAttachment {
  provider: LlmProviderName;
  fileId: string;
  filename?: string;
}

export interface ProviderTurnRequest<TTool = unknown> {
  agentId: AgentId;
  model: ModelRef;
  systemPrompt: string;
  inputText: string;
  thread: NativeThreadState;
  tools: TTool[];
  maxTurns: number;
  maxOutputTokens: number;
  attachment?: ProviderAttachment;
  // Compatibility path for provider-native one-turn attachments. Task 10
  // replaces this with ProviderAttachment end-to-end.
  attachments?: unknown[];
  onFrame?: (frame: ChatStreamFrame) => void | Promise<void>;
  onUsage: (usage: NormalizedUsage) => Promise<void>;
}

export interface ProviderTurnResult {
  thread: NativeThreadState;
  rounds: number;
  finalText: string;
  refused: boolean;
}

export interface ProviderGenerateRequest {
  model: ModelRef;
  systemPrompt: string;
  inputText: string;
  maxOutputTokens: number;
  onUsage: (usage: NormalizedUsage) => Promise<void>;
}

export interface ProviderError {
  provider: LlmProviderName;
  kind: string;
  retryable: boolean;
  threadCorrupt: boolean;
  status?: number;
  message: string;
}

export interface LlmProvider<TTool = unknown> {
  readonly name: LlmProviderName;
  isConfigured(): boolean;
  prepareThread(thread: NativeThreadState): NativeThreadState;
  runTurn(request: ProviderTurnRequest<TTool>): Promise<ProviderTurnResult>;
  generateText(request: ProviderGenerateRequest): Promise<string>;
  classifyError(error: unknown): ProviderError;
}
