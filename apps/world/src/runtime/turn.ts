// The shared turn machinery (M3 continuity). ONE turn = append an input to the
// agent's persistent thread, run the SDK tool runner (bounded, with server-side
// compaction), and persist the accumulated thread (incl. compaction blocks) ONLY
// on success. Used by both the loop (ticks + visitor turns) and reflection.
//
// We DO NOT hand-roll the dispatch loop — the SDK's toolRunner owns it (Phase 0:
// it forwards context_management and accumulates the full thread, including
// compaction blocks, into runner.params.messages). A turn that throws propagates
// to the caller WITHOUT persisting, so the prior thread stays intact and the
// triggering input simply retries.

import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";
import type { AgentId, ChatStreamFrame } from "@town/contract";
import { anthropic, systemBlocks, TICK_BETAS } from "./client.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { startTrace } from "./tracing.js";
import {
  loadThread,
  persistThread,
  buildSeedContext,
  type ThreadMessage,
} from "../engine/thread.js";

// How many tool rounds a single turn may take before we force a stop.
export const MAX_TURN_ROUNDS = 6;

// Server-side compaction (Phase 0). 50_000 is the API minimum (a lower value
// 400s) and our working-context floor; it's the main cost knob — higher = rarer
// but larger compaction passes. Phase 4 tunes it.
const COMPACT_TRIGGER_TOKENS = 50_000;
const COMPACTION_BETA = "compact-2026-01-12";
export const LOOP_BETAS = [...TICK_BETAS, COMPACTION_BETA] as const;
const COMPACTION = {
  edits: [
    {
      type: "compact_20260112" as const,
      trigger: { type: "input_tokens" as const, value: COMPACT_TRIGGER_TOKENS },
    },
  ],
};

// Streaming hooks for a visitor turn: each frame is one SSE `data` payload. Tick
// and reflection turns pass no handlers (they don't stream).
export interface TurnHandlers {
  onFrame: (frame: ChatStreamFrame) => void | Promise<void>;
}

export interface TurnOutcome {
  rounds: number;
  totalCost: number;
  totalCacheRead: number;
  refused: boolean;
  // The agent's plain assistant text across the turn — its utterance (speech
  // when there's an audience, a thought-aloud otherwise; the caller decides).
  finalText: string;
}

export interface RunTurnOptions {
  agentId: AgentId;
  model: string;
  maxTokens: number;
  // The input appended to the thread as a user turn (a world delta, the visitor's
  // words, the reflection prompt …).
  inputText: string;
  tools: BetaRunnableTool<unknown>[];
  // World-event high-water id this turn perceived, stored as the thread's input
  // cursor. Omit to preserve the existing cursor (a turn that perceived nothing).
  advanceCursorTo?: number | null;
  tickId: string;
  trace: ReturnType<typeof startTrace>;
  // When present, the turn STREAMS: plain-text deltas are emitted as `text`
  // frames as they arrive (for the visitor's panel typewriter). The caller still
  // owns turn_started/done framing and the agent.spoke emission.
  stream?: TurnHandlers;
}

// Run one turn on the agent's persistent thread (load → append input → run →
// persist on success). See the file header for the crash-safety contract.
export async function runTurn(opts: RunTurnOptions): Promise<TurnOutcome> {
  const { agentId, model, maxTokens, inputText, tools, tickId, trace, stream } = opts;

  const thread = await loadThread(agentId);
  // Strip any cache breakpoints carried over from a prior call's persisted input
  // so we never accumulate past the API's 4-breakpoint limit (we add exactly one
  // fresh breakpoint below).
  const messages: ThreadMessage[] = stripCacheControl(thread.messages);

  // Fresh thread → orient it (core memory + last diary) so a (re)started agent
  // picks up its life rather than booting cold. One-time, folded into this input.
  let firstInput = inputText;
  if (messages.length === 0) {
    const seed = await buildSeedContext(agentId);
    firstInput = `${seed}\n\n---\n\n${inputText}`;
  }

  // Cache breakpoint on the new input's block: this turn WRITES the cache up
  // through the input, and the next turn READS the whole thread prefix as a hit.
  // That keeps a long continuous thread economical (plan §6.4) — at our cadence
  // the 1h ephemeral TTL stays warm between turns. Stripped before persist.
  messages.push({
    role: "user",
    content: [
      { type: "text", text: firstInput, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  });

  let rounds = 0;
  let totalCost = 0;
  let totalCacheRead = 0;
  let refused = false;
  let finalText = "";

  // The common toolRunner params (the `stream` literal is added per branch so the
  // SDK return type narrows to BetaMessage vs BetaMessageStream correctly).
  const params = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks(agentId),
    messages,
    tools,
    max_iterations: MAX_TURN_ROUNDS,
    betas: [...LOOP_BETAS],
    context_management: COMPACTION,
  };

  const onRound = async (message: Anthropic.Beta.BetaMessage): Promise<void> => {
    rounds++;
    const t = tokensFromUsage(message.usage);
    const cost = estimateCostUsd(model, t);
    totalCost += cost;
    totalCacheRead += t.cacheReadTokens;
    await recordUsage({
      agentId,
      model,
      tickId,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      estCostUsd: cost,
    });
    trace.event("round", {
      round: rounds,
      stop_reason: message.stop_reason,
      cache_read_input_tokens: t.cacheReadTokens,
      cost,
    });
    if (message.stop_reason === "refusal") {
      refused = true;
      return;
    }
    const text = extractText(message);
    if (text && message.stop_reason === "end_turn") finalText = text;
  };

  // The accumulated thread (incl. compaction blocks) after the run, for persist.
  let accumulated: ThreadMessage[];

  if (stream) {
    // Streaming path (visitor turns): forward plain-text deltas live as `text`
    // frames; the SDK separates thinking deltas, so only spoken text streams.
    const runner = anthropic.beta.messages.toolRunner({ ...params, stream: true });
    for await (const roundStream of runner) {
      let buf = "";
      roundStream.on("text", (delta) => {
        buf += delta;
      });
      const message = await roundStream.finalMessage();
      if (buf.trim()) {
        await stream.onFrame({ type: "text", text: buf, agent: agentId });
      }
      await onRound(message);
      if (refused) {
        const note = "\n(— the agent declined to continue down that path.)";
        await stream.onFrame({ type: "text", text: note, agent: agentId });
        finalText += note;
        break;
      }
    }
    accumulated = runner.params.messages;
  } else {
    const runner = anthropic.beta.messages.toolRunner(params);
    for await (const message of runner) {
      await onRound(message);
      if (refused) break;
    }
    accumulated = runner.params.messages;
  }

  // Persist the accumulated thread — only reached when the loop ran to
  // completion. Strip the runtime cache breakpoint first.
  const cursor =
    opts.advanceCursorTo === undefined ? thread.inputCursor : opts.advanceCursorTo;
  await persistThread(agentId, stripCacheControl(accumulated), cursor);

  return { rounds, totalCost, totalCacheRead, refused, finalText };
}

export function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Remove cache_control from every content block so a persisted thread carries no
// breakpoints (we add exactly one fresh breakpoint per call; persisting them
// would accumulate past the API's 4-breakpoint limit). Setting it to undefined
// is dropped by JSON.stringify on persist, so the stored thread stays clean.
function stripCacheControl(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const content = m.content.map((b) =>
      "cache_control" in b && b.cache_control != null ? { ...b, cache_control: undefined } : b,
    );
    return { ...m, content };
  });
}
