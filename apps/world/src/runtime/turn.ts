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

// Tools that END the visitor's turn: the agent was told to say its piece IN THE
// SAME MESSAGE as the call, so that round's text is SPEECH, not stage direction
// (see classifyRoundText). Anything it writes afterwards is post-goodbye
// housekeeping and is dropped.
const TERMINAL_TOOLS = new Set(["leave_chat"]);

export function callsTerminalTool(message: Anthropic.Beta.BetaMessage): boolean {
  return message.content.some(
    (b) => b.type === "tool_use" && TERMINAL_TOOLS.has((b as { name: string }).name),
  );
}

// THE NARRATION GUARD, as a pure decision (2026-08-02). Pure so the rules below
// are pinned by tests instead of only reachable through a live streaming call.
//
// The guard exists because the model often writes stage direction before a tool
// call ("let me check my memory first…") — that's thinking, not speech to the
// visitor. The original rule was "only emit the round that ends the turn", and
// it was WRONG in two ways that cost real conversations:
//
//   1. `protocol.ts` and the visitor framing both instruct "say your goodbye and
//      call leave_chat in the same message" — the exact shape the rule threw
//      away. Researcher pitched P-Thomas two research directions in a
//      text+leave_chat round on 2026-08-02; the visitor received only the
//      "Catch you later" that came after the tool result. The agent's thread
//      still holds the pitch, so it believed it had answered — and said so in
//      the next session. Hobby lost a reply the same way the same evening.
//   2. The max-rounds fallback kept only the LAST held buffer, so on a long turn
//      an early real reply was overwritten by later housekeeping narration.
//      Builder greeted a visitor warmly in round 1, then spent five rounds
//      filing a capability request; the visitor got round 4's "Filed. Let me
//      update memory and DM Researcher…" and never saw the greeting.
//
// So: a terminal tool makes its round speech, and everything after it is dropped.
export type RoundDisposition = "emit" | "hold" | "drop";

export function classifyRoundText(opts: {
  hasText: boolean;
  stopReason: string | null;
  terminal: boolean;
  closed: boolean;
}): RoundDisposition {
  if (!opts.hasText) return "drop";
  // A terminal tool already fired this turn — the goodbye has been spoken and the
  // session is closing. Anything further is the agent tidying up after itself.
  if (opts.closed) return "drop";
  if (opts.terminal) return "emit";
  // Mid-turn text before a tool call: hold it. It's released only if the turn
  // never produces real speech (see releaseHeld).
  return opts.stopReason === "tool_use" ? "hold" : "emit";
}

// Every round ended in a tool call, so nothing was ever spoken. Release what the
// agent wrote rather than leaving the visitor with silence — ALL of it, oldest
// first: the substantive line usually comes first and the stage direction last,
// which is precisely the ordering the old keep-the-last-buffer rule inverted.
export function releaseHeld(held: string[]): string {
  return held.join("\n\n");
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
  // fresh breakpoint below), then prune history the API has already compacted
  // away. Pruning on LOAD as well as persist means an oversized legacy thread is
  // never UPLOADED even once — the shrink takes effect on this turn rather than
  // the next one. Safe because the pruned shape is byte-identical in input tokens
  // (verified against the live API for all five agents; see
  // pruneCompactedHistory).
  const messages: ThreadMessage[] = pruneCompactedHistory(stripForPersist(thread.messages));

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
    // Sonnet 5 turns adaptive thinking ON by default when `thinking` is omitted
    // (Sonnet 4.6 omitted == thinking-off). We pin adaptive + low effort so the
    // 24/7 loop gets a modest reasoning lift while staying close to the old
    // cost profile — far below the default `high` effort token spend.
    thinking: { type: "adaptive" as const },
    output_config: { effort: "low" as const },
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
    // Streaming path (visitor turns), governed by the narration guard — see
    // classifyRoundText above for the rules and the two conversations that
    // motivated them.
    const runner = anthropic.beta.messages.toolRunner({ ...params, stream: true });
    const held: string[] = [];
    const spoken: string[] = [];
    let closed = false;
    for await (const roundStream of runner) {
      let buf = "";
      roundStream.on("text", (delta) => {
        buf += delta;
      });
      const message = await roundStream.finalMessage();
      const terminal = callsTerminalTool(message);
      const disposition = classifyRoundText({
        hasText: buf.trim().length > 0,
        stopReason: message.stop_reason,
        terminal,
        closed,
      });
      if (disposition === "emit") {
        await stream.onFrame({ type: "text", text: buf, agent: agentId });
        spoken.push(buf.trim());
      } else if (disposition === "hold") {
        held.push(buf.trim());
      }
      // Only a terminal round that actually SPOKE closes the turn. An agent that
      // calls leave_chat with no text alongside it hasn't said goodbye yet — its
      // farewell legitimately arrives on the next round, and dropping that would
      // trade one silence bug for another.
      if (terminal && disposition === "emit") closed = true;
      await onRound(message);
      if (refused) {
        const note = "\n(— the agent declined to continue down that path.)";
        await stream.onFrame({ type: "text", text: note, agent: agentId });
        spoken.push(note);
        break;
      }
    }
    // Nothing was ever spoken (every round ended in a tool call and hit
    // max_iterations) → release what it wrote rather than leaving the visitor
    // with silence.
    if (spoken.length === 0 && held.length > 0) {
      const text = releaseHeld(held);
      await stream.onFrame({ type: "text", text, agent: agentId });
      spoken.push(text);
    }
    // finalText MUST be exactly what the visitor saw. It's what gets written to
    // the chat transcript and re-emitted as the agent.spoke bubble, so any
    // divergence means the panel, the room and the Chronicle tell different
    // stories about the same moment.
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

  // Persist the accumulated thread — only reached when the loop ran to
  // completion. Strip the cache breakpoint + ephemeral code-exec/upload blocks,
  // then drop history the API has already compacted away (see below).
  const cursor =
    opts.advanceCursorTo === undefined ? thread.inputCursor : opts.advanceCursorTo;
  await persistThread(agentId, pruneCompactedHistory(stripForPersist(accumulated)), cursor);

  return { rounds, totalCost, totalCacheRead, refused, finalText };
}

export function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Ephemeral block types that must not be REPLAYED verbatim: the server-side
// code-execution machinery + any dataset upload. They reference a sandbox
// container that no longer exists on a later turn, and replaying them risks a
// 400 that would poison (permanently break) the continuous thread — and they're
// bulky.
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

// …but DELETING them outright gave the agents code-execution amnesia (2026-08-02).
//
// Every turn carries CODE_EXEC_TOOL, so an agent can write and run Python. But
// because the blocks were dropped before persist, an agent that ran code this
// turn woke up next turn to a thread in which it never had. The habit could
// never form, and the self-model that DOES persist says the opposite: Builder
// told a visitor "half my building is me larping with write_artifact_state
// pretending it's a backend" and filed a capability request for a Python
// sandbox it has had all along — the second time it had asked for that exact
// thing (2026-06-14 and again 2026-08-02), because nothing in its memory
// disagreed.
//
// So we REPLACE rather than delete: a compact, past-tense, clamped text trace.
// The container is never referenced, so there's nothing for a later turn to
// replay; the agent just remembers that it ran something and what came back.
const TRACE_MAX_CHARS = 600;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (truncated)`;
}

// Render one ephemeral block as a durable one-line memory of the action.
// Returns undefined for blocks with nothing worth remembering.
export function summarizeEphemeralBlock(block: unknown): string | undefined {
  const b = block as {
    type: string;
    name?: string;
    input?: { code?: string } & Record<string, unknown>;
    content?: unknown;
  };
  switch (b.type) {
    case "server_tool_use":
    case "code_execution_tool_use":
    case "mcp_tool_use": {
      const name = b.name ?? "a server-side tool";
      const code = typeof b.input?.code === "string" ? b.input.code : undefined;
      if (code) return `[you ran ${name}:\n${clip(code, TRACE_MAX_CHARS)}]`;
      return `[you called ${name}: ${clip(JSON.stringify(b.input ?? {}), 200)}]`;
    }
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "mcp_tool_result": {
      const rendered = renderToolResult(b.content);
      return rendered ? `[it returned:\n${clip(rendered, TRACE_MAX_CHARS)}]` : undefined;
    }
    case "container_upload":
      return "[a dataset file was handed to your sandbox for this turn]";
    default:
      return undefined;
  }
}

function renderToolResult(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  const c = content as { stdout?: string; stderr?: string; error_code?: string };
  const parts = [c.stdout, c.stderr && `stderr: ${c.stderr}`, c.error_code && `error: ${c.error_code}`]
    .filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length) return parts.join("\n");
  return JSON.stringify(content);
}

// Prepare a thread for persistence: (1) drop cache_control from every block (we
// add a fresh breakpoint per call; persisting them would exceed the API's
// 4-breakpoint limit), (2) replace ephemeral code-exec/upload blocks with a
// durable text trace (see above), and (3) collapse multi-`thinking` assistant
// messages (see below). A message left with empty content is dropped entirely.
export function stripForPersist(messages: ThreadMessage[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content: ThreadMessage["content"] = [];
    // Did anything survive that ISN'T just a trace of a stripped block? Drives
    // the merge below: a message that used to vanish entirely must not now
    // appear as a brand-new message next to one of the same role.
    let keptReal = false;
    for (const b of m.content) {
      if (EPHEMERAL_BLOCK_TYPES.has((b as { type: string }).type)) {
        const trace = summarizeEphemeralBlock(b);
        if (trace) content.push({ type: "text", text: trace } as (typeof content)[number]);
        continue;
      }
      keptReal = true;
      content.push(
        "cache_control" in b && b.cache_control != null ? { ...b, cache_control: undefined } : b,
      );
    }
    if (content.length === 0) continue;

    // A message that is ONLY traces would previously have been dropped. Folding
    // it into the preceding same-role message keeps the trace without changing
    // the thread's message shape — no consecutive same-role messages appear that
    // weren't there before.
    const prev = out[out.length - 1];
    if (!keptReal && prev && prev.role === m.role && Array.isArray(prev.content)) {
      prev.content = [...prev.content, ...content];
      continue;
    }
    out.push({ ...m, content });
  }
  // collapseThinking runs LAST, after any merge above — merging two assistant
  // messages that each carried a thinking block would otherwise reconstruct the
  // exact multi-thinking shape that bricked Researcher for 27 days.
  return out.map((m) =>
    Array.isArray(m.content) ? { ...m, content: collapseThinking(m.content) } : m,
  );
}

// How many trailing compaction checkpoints to retain. 1 would be provably
// sufficient (see the measurement below); 2 keeps one checkpoint of slack, which
// costs almost nothing and preserves a little recent verbatim texture.
const KEEP_COMPACTIONS = 2;

// DROP HISTORY THE API HAS ALREADY COMPACTED AWAY (2026-07-30).
//
// Server-side compaction shrinks the WORKING CONTEXT but never touched what we
// persisted, so `agent_threads.content` grew without bound: 2.3–2.9 MB and
// 1,600–2,200 messages per agent, all of it loaded, JSON-parsed, deep-copied,
// re-serialized and UPLOADED on every single turn.
//
// Measured against the live API using Builder's real 2,183-message thread: the
// full thread and a 17-message suffix starting at the most recent compaction
// block both reported input_tokens = 15,021, exactly equal. The API discards
// everything before the newest compaction block — so ~99% of what we stored and
// shipped every turn was doing nothing at all. Pruning it is lossless by
// measurement, not by assumption.
//
// (Note for anyone chasing cost: this is NOT where the per-tick $ spread comes
// from. Cost tracks ROUNDS and output tokens — researcher's 6-round tick cost
// $0.38 while hobby's 2-round tick cost $0.03, on similar working contexts. The
// win here is DB size, latency, request payload and serialization work.)
//
// Anything genuinely durable already lives elsewhere: `world_events` is the
// queryable record, plus diaries, core memory and Hindsight. A thread with fewer
// than KEEP_COMPACTIONS checkpoints is left completely alone.
export function pruneCompactedHistory(
  messages: ThreadMessage[],
  keepCompactions = KEEP_COMPACTIONS,
): ThreadMessage[] {
  const compactionAt: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.some((b) => (b as { type?: string }).type === "compaction")) {
      compactionAt.push(i);
    }
  }
  if (compactionAt.length < keepCompactions) return messages;
  const from = compactionAt[compactionAt.length - keepCompactions];
  if (from <= 0) return messages;
  // The retained array starts at the assistant message carrying that compaction
  // block. A leading assistant message is unusual but VERIFIED accepted by the
  // API (that's exactly the shape the suffix probe above sent).
  const kept = messages.slice(from);
  console.log(
    `[thread] pruned ${from} pre-compaction message(s); ${kept.length} retained ` +
      `(${compactionAt.length} checkpoints seen, keeping last ${keepCompactions}).`,
  );
  return kept;
}

// THE POISONED-THREAD GUARD (2026-07-30). An assistant message carrying TWO
// consecutive `thinking` blocks is accepted when the API produces it but REJECTED
// when we replay it:
//
//   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
//   latest assistant message cannot be modified.
//
// Because the thread is replayed on every single turn, one such message bricks
// the agent permanently. Researcher Thomas hit this on 2026-07-03 and made zero
// LLM calls for the following 27 days; the offending blocks both had EMPTY
// thinking text and carried only signatures, so dropping the extras costs no
// reasoning content. We keep the first thinking block and drop later ones,
// which was verified against the live API to restore the thread to 200 OK.
function collapseThinking(blocks: ThreadMessage["content"]): ThreadMessage["content"] {
  if (typeof blocks === "string") return blocks;
  let seenThinking = false;
  const kept = blocks.filter((b) => {
    const t = (b as { type?: string }).type;
    if (t !== "thinking" && t !== "redacted_thinking") return true;
    if (seenThinking) return false;
    seenThinking = true;
    return true;
  });
  if (kept.length !== blocks.length) {
    console.warn(
      `[thread] dropped ${blocks.length - kept.length} extra thinking block(s) before persist ` +
        `(would poison the thread on replay).`,
    );
  }
  return kept;
}
