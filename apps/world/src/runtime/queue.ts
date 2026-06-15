// The per-agent input queue (M3 continuity). The agent's consciousness is
// single-threaded: ONE worker per agent drains a queue of inputs, one turn at a
// time. This replaces the old agent-lock mutex AND the tick-vs-chat engagement
// split — everything (scheduler ticks, visitor messages, reflection, a co-located
// agent's address) is just an input, and the queue serializes them.
//
// Priority has two tiers (design §2): INTERRUPT inputs (a visitor's message; a
// tick boosted by being addressed in the room) jump ahead of queued NORMAL inputs
// (scheduler ticks, reflection) but never abort a running turn — turns are
// bounded, so worst case an interrupt waits one turn. Normal ticks coalesce (a
// second queued tick is dropped) so a backed-up agent doesn't pile up stale ticks.
//
// In-memory, single-process (matches the Railway monolith). The actual turn is
// run by an executor the loop registers (registerExecutor) — keeping this module
// free of any import cycle with loop.ts.

import type { AgentId } from "@town/contract";
import type { TurnHandlers } from "./turn.js";

export type AgentInput =
  | { kind: "tick"; interrupt?: boolean }
  | { kind: "reflection" }
  | {
      kind: "visitor";
      sessionId: string;
      visitorId: string;
      visitorName: string;
      text: string;
      handlers: TurnHandlers;
    }
  // A one-time dataset handoff: a prompt + a Files-API file_id attached to the
  // turn as a container_upload, so the agent can analyze it in the code-exec
  // sandbox. Interrupt-tier (runs promptly).
  | { kind: "delivery"; fileId: string; prompt: string };

// The structured result an executor returns (superset of the loop's TickResult).
export interface ExecResult {
  ran: boolean;
  reason?: string;
  rounds?: number;
  costUsd?: number;
  cacheReadTokens?: number;
  traceId?: string;
}

type Executor = (agentId: AgentId, input: AgentInput) => Promise<ExecResult>;

let executor: Executor | null = null;

// The loop registers the actual turn-runner at module load. Until then, enqueue
// is a no-op-ish (resolves "no-executor") — only relevant in tests that import
// the queue without the loop.
export function registerExecutor(fn: Executor): void {
  executor = fn;
}

interface QueueItem {
  input: AgentInput;
  interrupt: boolean;
  resolve: (r: ExecResult) => void;
  reject: (e: unknown) => void;
}

const queues = new Map<AgentId, QueueItem[]>();
const running = new Set<AgentId>();

function isInterrupt(input: AgentInput): boolean {
  if (input.kind === "visitor" || input.kind === "delivery") return true;
  if (input.kind === "tick") return Boolean(input.interrupt);
  return false;
}

// Enqueue an input for an agent and return a promise that resolves when THAT
// input has been processed (the visitor HTTP handler awaits it to hold the SSE
// stream open; the scheduler ignores it). Coalesces duplicate ticks.
export function enqueue(agentId: AgentId, input: AgentInput): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const q = queues.get(agentId) ?? [];
    const interrupt = isInterrupt(input);

    // Coalesce ticks: at most one normal tick and one interrupt tick queued at a
    // time. A duplicate resolves immediately as coalesced (the already-queued one
    // will run with fresh world state anyway).
    if (input.kind === "tick") {
      const dup = q.some((i) => i.input.kind === "tick" && i.interrupt === interrupt);
      if (dup) {
        resolve({ ran: false, reason: "coalesced" });
        return;
      }
    }

    const item: QueueItem = { input, interrupt, resolve, reject };
    if (interrupt) {
      // Insert after any other interrupts but ahead of the first normal item.
      const idx = q.findIndex((i) => !i.interrupt);
      if (idx === -1) q.push(item);
      else q.splice(idx, 0, item);
    } else {
      q.push(item);
    }
    queues.set(agentId, q);
    void drain(agentId);
  });
}

// Drain an agent's queue, one input at a time. A single worker per agent (guarded
// by `running`) guarantees the consciousness is single-threaded.
async function drain(agentId: AgentId): Promise<void> {
  if (running.has(agentId)) return;
  running.add(agentId);
  try {
    for (;;) {
      const q = queues.get(agentId);
      const item = q?.shift();
      if (!item) break;
      if (!q || q.length === 0) queues.delete(agentId);
      try {
        const result = executor
          ? await executor(agentId, item.input)
          : { ran: false, reason: "no-executor" };
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
  } finally {
    running.delete(agentId);
  }
}

// Test seam: clear all queues (does not stop an in-flight turn).
export function _resetQueueForTest(): void {
  queues.clear();
  running.clear();
}
