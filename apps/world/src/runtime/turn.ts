// Provider-neutral turn coordinator. It owns portable orchestration and the
// crash-safe persistence boundary; provider adapters own SDK loops, native
// history hygiene, tool wrapping, compaction, and streaming event decoding.

import type { AgentId, ChatStreamFrame } from "@town/contract";
import { loadThread, persistThread, buildSeedContext } from "../engine/thread.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd } from "./pricing.js";
import { startTrace } from "./tracing.js";
import { getLlmProvider } from "./llm/provider.js";
import { buildSystemPrompt } from "./llm/system.js";
import type { ModelRef } from "./llm/types.js";
import type { TownTool } from "./llm/tool.js";

export { classifyRoundText, releaseHeld } from "./llm/speech.js";
export {
  pruneCompactedHistory,
  stripForPersist,
  summarizeEphemeralBlock,
} from "./llm/anthropic/history.js";

export const MAX_TURN_ROUNDS = 6;

export interface TurnHandlers {
  onFrame: (frame: ChatStreamFrame) => void | Promise<void>;
}

export interface TurnOutcome {
  rounds: number;
  totalCost: number;
  totalCacheRead: number;
  refused: boolean;
  finalText: string;
}

export interface RunTurnOptions {
  agentId: AgentId;
  model: ModelRef;
  maxTokens: number;
  inputText: string;
  tools: TownTool[];
  advanceCursorTo?: number | null;
  tickId: string;
  trace: ReturnType<typeof startTrace>;
  stream?: TurnHandlers;
  attachments?: unknown[];
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutcome> {
  const provider = getLlmProvider(opts.model.provider);
  const loaded = await loadThread(opts.agentId, opts.model.provider);
  const prepared = provider.prepareThread({
    provider: opts.model.provider,
    items: loaded.items,
  });

  let inputText = opts.inputText;
  if (prepared.items.length === 0) {
    const seed = await buildSeedContext(opts.agentId);
    inputText = `${seed}\n\n---\n\n${opts.inputText}`;
  }

  let totalCost = 0;
  let totalCacheRead = 0;
  const result = await provider.runTurn({
    agentId: opts.agentId,
    model: opts.model,
    systemPrompt: buildSystemPrompt(opts.agentId),
    inputText,
    thread: prepared,
    tools: opts.tools,
    maxTurns: MAX_TURN_ROUNDS,
    maxOutputTokens: opts.maxTokens,
    attachments: opts.attachments,
    onFrame: opts.stream?.onFrame,
    onUsage: async (usage) => {
      const tokens = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      };
      const cost = estimateCostUsd(usage.provider, usage.model, tokens);
      totalCost += cost;
      totalCacheRead += usage.cacheReadTokens;
      await recordUsage({
        agentId: opts.agentId,
        provider: usage.provider,
        model: usage.model,
        endpoint: usage.endpoint,
        tickId: opts.tickId,
        ...tokens,
        estCostUsd: cost,
      });
      opts.trace.event("round", {
        round: usage.round,
        stop_reason: usage.stopReason,
        cache_read_input_tokens: usage.cacheReadTokens,
        cost,
      });
    },
  });

  const cursor =
    opts.advanceCursorTo === undefined ? loaded.inputCursor : opts.advanceCursorTo;
  await persistThread(opts.agentId, opts.model.provider, result.thread.items, cursor);

  return {
    rounds: result.rounds,
    totalCost,
    totalCacheRead,
    refused: result.refused,
    finalText: result.finalText,
  };
}
