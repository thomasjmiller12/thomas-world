import type Anthropic from "@anthropic-ai/sdk";
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
import { anthropic, anthropicSystemBlocks, TICK_BETAS } from "./client.js";
import {
  pruneCompactedHistory,
  stripForPersist,
  type AnthropicThreadMessage,
} from "./history.js";
import { toAnthropicTools } from "./tools.js";
import { normalizeAnthropicUsage } from "./usage.js";

const COMPACT_TRIGGER_TOKENS = 50_000;
const COMPACTION_BETA = "compact-2026-01-12";
const FILES_BETA = "files-api-2025-04-14";
export const LOOP_BETAS = [...TICK_BETAS, COMPACTION_BETA, FILES_BETA] as const;

const CODE_EXEC_TOOL = { type: "code_execution_20260120", name: "code_execution" } as const;

const CLEAR_TRIGGER = Number(process.env.CONTEXT_CLEAR_TRIGGER_TOKENS ?? "");
const CLEAR_EDIT =
  Number.isFinite(CLEAR_TRIGGER) && CLEAR_TRIGGER > 0
    ? [
        {
          type: "clear_tool_uses_20250919" as const,
          trigger: { type: "input_tokens" as const, value: CLEAR_TRIGGER },
          keep: { type: "tool_uses" as const, value: 5 },
        },
      ]
    : [];
const COMPACTION = {
  edits: [
    ...CLEAR_EDIT,
    {
      type: "compact_20260112" as const,
      trigger: { type: "input_tokens" as const, value: COMPACT_TRIGGER_TOKENS },
    },
  ],
};

const TERMINAL_TOOLS = new Set(["leave_chat"]);

function callsTerminalTool(message: Anthropic.Beta.BetaMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === "tool_use" && TERMINAL_TOOLS.has((block as { name: string }).name),
  );
}

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function runAnthropicTurn(
  request: ProviderTurnRequest<TownTool>,
): Promise<ProviderTurnResult> {
  if (request.model.provider !== "anthropic" || request.thread.provider !== "anthropic") {
    throw new Error("Anthropic adapter received non-Anthropic model or thread state");
  }
  if (request.attachment && request.attachment.provider !== "anthropic") {
    throw new Error(
      `Anthropic adapter cannot use a ${request.attachment.provider} attachment`,
    );
  }

  const messages = pruneCompactedHistory(
    stripForPersist(request.thread.items as AnthropicThreadMessage[]),
  );
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: request.inputText,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      ...(request.attachment
        ? ([
            {
              type: "container_upload",
              file_id: request.attachment.fileId,
            },
          ] as Anthropic.Beta.BetaContentBlockParam[])
        : []),
    ],
  });

  let rounds = 0;
  let refused = false;
  let finalText = "";
  const params = {
    model: request.model.model,
    max_tokens: request.maxOutputTokens,
    thinking: { type: "adaptive" as const },
    output_config: { effort: "low" as const },
    system: anthropicSystemBlocks(request.systemPrompt),
    messages,
    tools: [...toAnthropicTools(request.tools), CODE_EXEC_TOOL],
    max_iterations: request.maxTurns,
    betas: [...LOOP_BETAS],
    context_management: COMPACTION,
  };

  const onRound = async (message: Anthropic.Beta.BetaMessage): Promise<void> => {
    rounds++;
    await request.onUsage(
      normalizeAnthropicUsage(
        request.model.model,
        message.usage,
        "turn",
        rounds,
        message.stop_reason,
      ),
    );
    if (message.stop_reason === "refusal") {
      refused = true;
      return;
    }
    const text = extractText(message);
    if (text && message.stop_reason === "end_turn") finalText = text;
  };

  let accumulated: AnthropicThreadMessage[];
  if (request.onFrame) {
    const runner = anthropic.beta.messages.toolRunner({ ...params, stream: true });
    const held: string[] = [];
    const spoken: string[] = [];
    let closed = false;
    for await (const roundStream of runner) {
      let buffer = "";
      roundStream.on("text", (delta) => {
        buffer += delta;
      });
      const message = await roundStream.finalMessage();
      const terminal = callsTerminalTool(message);
      const disposition = classifyRoundText({
        hasText: buffer.trim().length > 0,
        stopReason: message.stop_reason,
        terminal,
        closed,
      });
      if (disposition === "emit") {
        await request.onFrame({ type: "text", text: buffer, agent: request.agentId });
        spoken.push(buffer.trim());
      } else if (disposition === "hold") {
        held.push(buffer.trim());
      }
      if (terminal && disposition === "emit") closed = true;
      await onRound(message);
      if (refused) {
        const note = "\n(— the agent declined to continue down that path.)";
        await request.onFrame({ type: "text", text: note, agent: request.agentId });
        spoken.push(note);
        break;
      }
    }
    if (spoken.length === 0 && held.length > 0) {
      const text = releaseHeld(held);
      await request.onFrame({ type: "text", text, agent: request.agentId });
      spoken.push(text);
    }
    finalText = spoken.join("\n\n");
    accumulated = runner.params.messages;
  } else {
    const runner = anthropic.beta.messages.toolRunner(params);
    for await (const message of runner) {
      await onRound(message);
      if (refused) break;
    }
    accumulated = runner.params.messages;
  }

  return {
    thread: {
      provider: "anthropic",
      items: pruneCompactedHistory(stripForPersist(accumulated)),
    },
    rounds,
    refused,
    finalText,
  };
}

async function generateAnthropicText(request: ProviderGenerateRequest): Promise<string> {
  if (request.model.provider !== "anthropic") {
    throw new Error("Anthropic adapter received a non-Anthropic model");
  }
  const response = await anthropic.messages.create({
    model: request.model.model,
    max_tokens: request.maxOutputTokens,
    system: request.systemPrompt,
    messages: [{ role: "user", content: request.inputText }],
  });
  await request.onUsage(
    normalizeAnthropicUsage(
      request.model.model,
      response.usage as Anthropic.Beta.BetaUsage,
      "generate",
      1,
      response.stop_reason,
    ),
  );
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function classifyAnthropicError(error: unknown): ProviderError {
  const candidate = error as { status?: number; message?: string };
  const status = candidate.status;
  return {
    provider: "anthropic",
    kind: status === 429 ? "rate_limit" : status && status >= 500 ? "provider" : "request",
    retryable: status === 429 || (status != null && status >= 500),
    threadCorrupt: false,
    status,
    message: candidate.message ?? String(error),
  };
}

export const anthropicProvider: LlmProvider<TownTool> = {
  name: "anthropic",
  isConfigured: () => Boolean(config.anthropicApiKey),
  prepareThread: (thread) => ({
    provider: "anthropic",
    items: pruneCompactedHistory(stripForPersist(thread.items as AnthropicThreadMessage[])),
  }),
  runTurn: runAnthropicTurn,
  generateText: generateAnthropicText,
  classifyError: classifyAnthropicError,
};
