// Provider-neutral turn coordinator. It owns portable orchestration and the
// crash-safe persistence boundary; provider adapters own SDK loops, native
// history hygiene, tool wrapping, compaction, and streaming event decoding.

import type { AgentId, ChatStreamFrame } from "@town/contract";
import { loadThread, persistThread, buildSeedContext } from "../engine/thread.js";
import { recordNormalizedUsage } from "../engine/usage.js";
import { startTrace } from "./tracing.js";
import { getLlmProvider } from "./llm/provider.js";
import { buildSystemPrompt } from "./llm/system.js";
import type { ModelRef, ProviderAttachment } from "./llm/types.js";
import type { TownTool } from "./llm/tool.js";
import { journalMutatingTools } from "./action-journal.js";
import { turnContext, permitsCodeExecution, type TurnPurpose } from "./turn-context.js";

export { classifyRoundText, releaseHeld } from "./llm/speech.js";

// Six rounds was routinely exhausted by a normal visitor turn that checked
// state, used two tools, and then answered. Eight keeps the bound tight while
// leaving enough room for a complete response; the OpenAI adapter also performs
// one explicit continuation on MaxTurnsExceededError and persists partial work.
export const MAX_TURN_ROUNDS = 8;

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
  purpose: TurnPurpose;
  model: ModelRef;
  maxTokens: number;
  inputText: string;
  tools: TownTool[];
  advanceCursorTo?: number | null;
  tickId: string;
  trace: ReturnType<typeof startTrace>;
  stream?: TurnHandlers;
  attachment?: ProviderAttachment;
  // Stable logical input identity used to dedupe mutating tools across provider
  // retries/process recovery. Defaults to tickId when the caller has no better
  // source identity.
  actionScope?: string;
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutcome> {
  const provider = getLlmProvider(opts.model.provider);
  const loaded = await loadThread(opts.agentId, opts.model.provider);
  const prepared = provider.prepareThread({
    provider: opts.model.provider,
    items: loaded.items,
  });

  let inputText = `${turnContext(opts.purpose)}\n\n${opts.inputText}`;
  if (prepared.items.length === 0) {
    const seed = await buildSeedContext(opts.agentId);
    inputText = `${seed}\n\n---\n\n${inputText}`;
  }

  let totalCost = 0;
  let totalCacheRead = 0;
  const result = await provider.runTurn({
    agentId: opts.agentId,
    model: opts.model,
    systemPrompt: buildSystemPrompt(opts.agentId),
    inputText,
    thread: prepared,
    tools: journalMutatingTools(opts.tools, {
      turnId: opts.actionScope ?? opts.tickId,
      agentId: opts.agentId,
    }),
    maxTurns: MAX_TURN_ROUNDS,
    maxOutputTokens: opts.maxTokens,
    attachment: opts.attachment,
    codeExecution: permitsCodeExecution(opts.purpose),
    onFrame: opts.stream?.onFrame,
    onUsage: async (usage) => {
      const cost = await recordNormalizedUsage({
        agentId: opts.agentId,
        tickId: opts.tickId,
        usage,
      });
      totalCost += cost;
      totalCacheRead += usage.cacheReadTokens;
      opts.trace.event("round", {
        provider: usage.provider,
        model: usage.model,
        endpoint: usage.endpoint,
        thread_provider: opts.model.provider,
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
