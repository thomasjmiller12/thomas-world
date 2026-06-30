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
// Files API beta — needed so a turn can carry a `container_upload` block (a
// dataset handed to the code-execution sandbox). Harmless on turns without one.
const FILES_BETA = "files-api-2025-04-14";
export const LOOP_BETAS = [...TICK_BETAS, COMPACTION_BETA, FILES_BETA] as const;

// Anthropic's server-side code-execution tool (GA). Added to every turn so agents
// can write + run Python in a hosted sandbox (compute, data analysis). The runner
// passes it through — the API executes it server-side and returns the result
// inline; there's no run() to dispatch. Results are STRIPPED before persist (see
// stripForPersist) so the ephemeral sandbox blocks never bloat or poison the
// continuous thread on replay — the agent's text takeaways are what persist.
const CODE_EXEC_TOOL = { type: "code_execution_20260120", name: "code_execution" } as const;

// Optional context-editing pass (cost lever, GATED). When
// CONTEXT_CLEAR_TRIGGER_TOKENS is set, clear OLD tool results once the working
// context crosses that many input tokens (keeping the most recent few), so
// verbatim file/note/artifact reads don't ride in the thread forever. It fires
// BELOW the compaction trigger so cheap clearing handles tool-result bloat and
// the (more expensive, summarizing) compaction fires rarely. The beta header it
// needs (context-management-2025-06-27) is already in TICK_BETAS.
//
// OFF by default: a bad context_management config 400s every turn, and the
// compact+clear combination isn't yet validated against the live API. Enable by
// setting CONTEXT_CLEAR_TRIGGER_TOKENS (e.g. 40000) once the town is confirmed
// up, then watch /debug + logs for 400s before trusting it.
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
  // Extra content blocks appended to the input user turn — e.g. a
  // `container_upload` handing a dataset to the code-execution sandbox. Stripped
  // before persist (one-time delivery, not part of the durable thread).
  attachments?: unknown[];
}

// Run one turn on the agent's persistent thread (load → append input → run →
// persist on success). See the file header for the crash-safety contract.
export async function runTurn(opts: RunTurnOptions): Promise<TurnOutcome> {
  const { agentId, model, maxTokens, inputText, tools, tickId, trace, stream } = opts;

  const thread = await loadThread(agentId);
  // Strip any cache breakpoints carried over from a prior call's persisted input
  // so we never accumulate past the API's 4-breakpoint limit (we add exactly one
  // fresh breakpoint below).
  const messages: ThreadMessage[] = stripForPersist(thread.messages);

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
      ...((opts.attachments ?? []) as Anthropic.Beta.BetaContentBlockParam[]),
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
    // The user tools (runner dispatches their run()) plus the server-side
    // code-execution tool (API runs it inline; no run() needed).
    tools: [...tools, CODE_EXEC_TOOL] as typeof tools,
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
    // Streaming path (visitor turns) with a NARRATION GUARD: the model often
    // emits text BEFORE a tool call ("let me check my memory first… now let me DM
    // Researcher") — that's internal stage-direction, NOT speech to the visitor.
    // We buffer each round and only emit the text of the round that ENDS THE TURN
    // (stop_reason !== tool_use); pre-tool narration is suppressed. Fallback: if
    // the turn hit max rounds without a clean finish, emit the last buffer so the
    // visitor never gets silence. (Without this guard the agent narrates its whole
    // tool process at the visitor — the M3 cutover regression this restores.)
    const runner = anthropic.beta.messages.toolRunner({ ...params, stream: true });
    let lastToolBuffer = "";
    let emittedAny = false;
    for await (const roundStream of runner) {
      let buf = "";
      roundStream.on("text", (delta) => {
        buf += delta;
      });
      const message = await roundStream.finalMessage();
      if (message.stop_reason === "tool_use") {
        if (buf.trim()) lastToolBuffer = buf; // internal narration — held back
      } else if (buf.trim()) {
        await stream.onFrame({ type: "text", text: buf, agent: agentId });
        emittedAny = true;
      }
      await onRound(message);
      if (refused) {
        const note = "\n(— the agent declined to continue down that path.)";
        await stream.onFrame({ type: "text", text: note, agent: agentId });
        finalText += note;
        emittedAny = true;
        break;
      }
    }
    // Every round ended in a tool call (max_iterations, no clean reply) → surface
    // the last thing it said rather than leaving the visitor hanging.
    if (!emittedAny && lastToolBuffer.trim()) {
      await stream.onFrame({ type: "text", text: lastToolBuffer, agent: agentId });
      if (!finalText) finalText = lastToolBuffer;
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
  // completion. Strip the cache breakpoint + ephemeral code-exec/upload blocks.
  const cursor =
    opts.advanceCursorTo === undefined ? thread.inputCursor : opts.advanceCursorTo;
  await persistThread(agentId, stripForPersist(accumulated), cursor);

  return { rounds, totalCost, totalCacheRead, refused, finalText };
}

export function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Ephemeral block types we DROP before persisting a thread: the server-side
// code-execution machinery + any dataset upload. They reference a sandbox
// container that no longer exists on a later turn, and replaying them risks a
// 400 that would poison (permanently break) the continuous thread — and they're
// bulky. The agent's plain TEXT takeaways from the analysis are kept, so its
// memory of "what I found" persists; only the raw tool plumbing is dropped.
const EPHEMERAL_BLOCK_TYPES = new Set([
  "server_tool_use",
  "code_execution_tool_use",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "container_upload",
  "mcp_tool_use",
  "mcp_tool_result",
]);

// Prepare a thread for persistence: (1) drop cache_control from every block (we
// add a fresh breakpoint per call; persisting them would exceed the API's
// 4-breakpoint limit) and (2) drop ephemeral code-exec/upload blocks (see above).
// A message left with empty content after filtering is dropped entirely.
function stripForPersist(messages: ThreadMessage[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content = m.content
      .filter((b) => !EPHEMERAL_BLOCK_TYPES.has((b as { type: string }).type))
      .map((b) =>
        "cache_control" in b && b.cache_control != null ? { ...b, cache_control: undefined } : b,
      );
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}
