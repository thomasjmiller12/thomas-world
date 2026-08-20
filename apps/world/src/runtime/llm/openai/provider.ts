import {
  Agent,
  MaxTurnsExceededError,
  codeInterpreterTool,
  type AgentOutputItem,
  type ModelResponse,
  type NonStreamRunOptions,
  type StreamRunOptions,
} from "@openai/agents";
import { config } from "../../../config.js";
import type { TownTool } from "../tool.js";
import type {
  LlmProvider,
  ProviderError,
  ProviderGenerateRequest,
  ProviderTurnRequest,
  ProviderTurnResult,
} from "../types.js";
import { classifyRoundText, releaseHeld } from "../speech.js";
import {
  createOpenAISession,
  OPENAI_CONTEXT_MANAGEMENT,
  openaiClient,
  openaiRunner,
} from "./client.js";
import { prepareOpenAIHistory } from "./history.js";
import { toOpenAITools } from "./tools.js";
import { normalizeOpenAIResponseUsage, normalizeOpenAIRunUsage } from "./usage.js";

const TERMINAL_TOOLS = new Set(["leave_chat"]);
const CONTINUATION_TURNS = 4;
const CONTINUATION_INPUT =
  "[operator continuation] You reached the bounded tool-round limit after completing real work. " +
  "The completed tool calls above are authoritative and must not be repeated. Finish the current task now, " +
  "state the result clearly in a complete final response, and stop using tools unless one is strictly necessary.";
const BOUNDED_STOP_TEXT =
  "I made progress on that, but the task ran longer than I could finish safely in one pass. " +
  "What I completed is saved; ask me to continue and I’ll pick up from there.";

interface OpenAIRunResultLike {
  finalOutput?: unknown;
  rawResponses: ModelResponse[];
  state: { usage: Parameters<typeof normalizeOpenAIRunUsage>[1] };
}

function messageText(item: AgentOutputItem): { text: string; refused: boolean } {
  if (item.type !== "message" || item.role !== "assistant") {
    return { text: "", refused: false };
  }
  let refused = false;
  const text = item.content
    .flatMap((part) => {
      if (part.type === "refusal") {
        refused = true;
        return [];
      }
      return part.type === "output_text" ? [part.text] : [];
    })
    .join("\n")
    .trim();
  return { text, refused };
}

function responseSpeech(responses: ModelResponse[]): {
  spoken: string[];
  refused: boolean;
} {
  const held: string[] = [];
  const spoken: string[] = [];
  let closed = false;
  let refused = false;

  for (const response of responses) {
    const terminal = response.output.some(
      (item) => item.type === "function_call" && TERMINAL_TOOLS.has(item.name),
    );
    const hasLocalTool = response.output.some((item) => item.type === "function_call");
    const messages = response.output.map(messageText);
    refused ||= messages.some((message) => message.refused);
    const text = messages.map((message) => message.text).filter(Boolean).join("\n\n");
    const disposition = classifyRoundText({
      hasText: text.length > 0,
      stopReason: hasLocalTool ? "tool_use" : "end_turn",
      terminal,
      closed,
    });
    if (disposition === "emit") spoken.push(text);
    else if (disposition === "hold") held.push(text);
    if (terminal && disposition === "emit") closed = true;
  }

  if (spoken.length === 0 && held.length > 0) spoken.push(releaseHeld(held));
  if (refused && spoken.length === 0) {
    spoken.push("(— the agent declined to continue down that path.)");
  }
  return { spoken, refused };
}

function createTurnAgent(request: ProviderTurnRequest<TownTool>): Agent {
  if (request.attachment && request.attachment.provider !== "openai") {
    throw new Error(`OpenAI adapter cannot use a ${request.attachment.provider} attachment`);
  }
  const fileIds = request.attachment ? [request.attachment.fileId] : [];
  return new Agent({
    name: `${request.agentId}-thomas`,
    instructions: request.systemPrompt,
    model: request.model.model,
    tools: [
      ...toOpenAITools(request.tools),
      codeInterpreterTool({
        includeOutputs: true,
        container: {
          type: "auto",
          ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
        },
      }),
    ],
    modelSettings: {
      maxTokens: request.maxOutputTokens,
      reasoning: { effort: "low", summary: "concise", context: "all_turns" },
      text: { verbosity: "low" },
      parallelToolCalls: false,
      truncation: "auto",
      store: false,
      // Verified live against gpt-5.4 on 2026-08-18: the model rejects the
      // Agents SDK's explicit prompt_cache_options field. Prefix caching is
      // automatic, so keep the system instructions byte-stable and request
      // only the supported retention policy.
      promptCacheRetention: "24h",
      contextManagement: [...OPENAI_CONTEXT_MANAGEMENT],
      preserveRawUsage: true,
    },
  });
}

async function finishRun(
  request: ProviderTurnRequest<TownTool>,
  session: ReturnType<typeof createOpenAISession>,
): Promise<OpenAIRunResultLike> {
  const agent = createTurnAgent(request);
  const baseOptions = {
    session,
    maxTurns: request.maxTurns,
  };
  if (!request.onFrame) {
    return (await openaiRunner.run(
      agent,
      request.inputText,
      baseOptions as NonStreamRunOptions,
    )) as unknown as OpenAIRunResultLike;
  }

  const streamed = await openaiRunner.run(agent, request.inputText, {
    ...baseOptions,
    stream: true,
  } as StreamRunOptions);
  for await (const _event of streamed) {
    // Consume the real stream, but emit only complete model-response text below.
    // Token deltas cannot satisfy the terminal-speech/finalText invariant.
  }
  await streamed.completed;
  if (streamed.error) throw streamed.error;
  return streamed as unknown as OpenAIRunResultLike;
}

async function runOpenAITurn(
  request: ProviderTurnRequest<TownTool>,
): Promise<ProviderTurnResult> {
  if (request.model.provider !== "openai" || request.thread.provider !== "openai") {
    throw new Error("OpenAI adapter received a non-OpenAI model or thread state");
  }
  const initialItems = prepareOpenAIHistory(request.thread.items);
  const session = createOpenAISession(initialItems, request.model.model);
  let result: OpenAIRunResultLike;
  let partialRounds = 0;
  try {
    result = await finishRun(request, session);
  } catch (error) {
    if (!(error instanceof MaxTurnsExceededError)) throw error;

    // The Agents SDK session already contains every completed model item and
    // tool result from the bounded run. Account for that work, then continue on
    // the SAME session so the model sees—and does not repeat—its body actions.
    const partialUsage = error.state?.usage;
    if (partialUsage) {
      const normalized = normalizeOpenAIRunUsage(
        request.model.model,
        partialUsage as unknown as Parameters<typeof normalizeOpenAIRunUsage>[1],
        "turn",
      );
      partialRounds = normalized.filter((usage) => usage.endpoint === "turn").length;
      for (const usage of normalized) await request.onUsage(usage);
    } else {
      partialRounds = request.maxTurns;
    }

    try {
      result = await finishRun(
        {
          ...request,
          inputText: CONTINUATION_INPUT,
          maxTurns: CONTINUATION_TURNS,
        },
        session,
      );
    } catch (continuationError) {
      if (!(continuationError instanceof MaxTurnsExceededError)) throw continuationError;
      const continuationUsage = continuationError.state?.usage;
      if (continuationUsage) {
        for (const usage of normalizeOpenAIRunUsage(
          request.model.model,
          continuationUsage as unknown as Parameters<typeof normalizeOpenAIRunUsage>[1],
          "turn",
        )) {
          await request.onUsage(usage);
        }
      }
      const items = prepareOpenAIHistory(await session.getItems());
      if (request.onFrame) {
        await request.onFrame({ type: "text", text: BOUNDED_STOP_TEXT, agent: request.agentId });
      }
      return {
        thread: { provider: "openai", items },
        rounds: partialRounds + CONTINUATION_TURNS,
        finalText: BOUNDED_STOP_TEXT,
        refused: false,
      };
    }
  }

  for (const usage of normalizeOpenAIRunUsage(
    request.model.model,
    result.state.usage,
    "turn",
  )) {
    await request.onUsage(usage);
  }

  const speech = responseSpeech(result.rawResponses);
  if (request.onFrame) {
    for (const text of speech.spoken) {
      await request.onFrame({ type: "text", text, agent: request.agentId });
    }
  }

  const finalOutput = typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
  const finalText = speech.spoken.join("\n\n") || finalOutput;
  const items = prepareOpenAIHistory(await session.getItems());
  return {
    thread: { provider: "openai", items },
    rounds: partialRounds + result.rawResponses.length,
    finalText,
    refused: speech.refused,
  };
}

async function generateOpenAIText(request: ProviderGenerateRequest): Promise<string> {
  if (request.model.provider !== "openai") {
    throw new Error("OpenAI adapter received a non-OpenAI model");
  }
  const response = await openaiClient.responses.create({
    model: request.model.model,
    instructions: request.systemPrompt,
    input: request.inputText,
    max_output_tokens: request.maxOutputTokens,
    reasoning: { effort: "low", summary: "concise" },
    text: { verbosity: "low" },
    store: false,
  });
  await request.onUsage(
    normalizeOpenAIResponseUsage(request.model.model, response.usage, "generate"),
  );
  return response.output_text.trim();
}

const OPENAI_THREAD_CORRUPTION = [
  /function_call(?:_output)?.*(?:missing|without|no matching).*(?:call|output)/i,
  /(?:missing|no matching).*function_call(?:_output)?/i,
  /reasoning item.*(?:invalid|missing|required|cannot)/i,
  /compaction item.*(?:invalid|missing|required|cannot)/i,
  /invalid.*(?:input|history) item/i,
];

export function classifyOpenAIError(error: unknown): ProviderError {
  const candidate = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const status = candidate.status ?? candidate.statusCode;
  const message = candidate.message ?? String(error);
  const timeout =
    candidate.name === "APIConnectionTimeoutError" ||
    candidate.code === "ETIMEDOUT" ||
    /timed? out|timeout/i.test(message);
  const threadCorrupt =
    status === 400 && OPENAI_THREAD_CORRUPTION.some((pattern) => pattern.test(message));
  const retryable = timeout || status === 429 || (status != null && status >= 500);
  const kind = threadCorrupt
    ? "thread_corrupt"
    : timeout
      ? "timeout"
      : status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate_limit"
          : status != null && status >= 500
            ? "provider"
            : status === 404
              ? "model_access"
              : /refus(?:al|ed)/i.test(message)
                ? "refusal"
                : "request";
  return {
    provider: "openai",
    kind,
    retryable,
    threadCorrupt,
    status,
    message,
  };
}

export const openaiProvider: LlmProvider<TownTool> = {
  name: "openai",
  isConfigured: () => Boolean(config.openaiApiKey),
  prepareThread: (thread) => ({
    provider: "openai",
    items: prepareOpenAIHistory(thread.items),
  }),
  runTurn: runOpenAITurn,
  generateText: generateOpenAIText,
  classifyError: classifyOpenAIError,
};
