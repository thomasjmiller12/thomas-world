// Per-agent in-process serialization (verification fix). A single Node process
// runs the scheduler, the /admin/tick endpoint, conversation scenes, and chat —
// all of which can act on the same agent. The `busy` DB flag guards the
// scheduler against chat/scenes, but it does NOT prevent two runTick calls for
// one agent overlapping (e.g. the scheduler timer and POST /admin/tick firing at
// once), which would double-bill the budget and whipsaw the perception cursor.
//
// This is a tiny per-agent async mutex: entry to runTick / runReflection (and
// any other agent-mutating critical section) takes the lock; concurrent callers
// either wait or are told the agent is busy, depending on the helper used.

import type { AgentId } from "@town/contract";

const held = new Set<AgentId>();
const waiters = new Map<AgentId, Array<() => void>>();

// Try to take the lock without waiting. Returns a release fn, or null if the
// agent is already locked (caller should treat as "busy" and skip).
export function tryAcquire(agentId: AgentId): (() => void) | null {
  if (held.has(agentId)) return null;
  held.add(agentId);
  return makeRelease(agentId);
}

// Take the lock, waiting in FIFO order if it's currently held. Use when the
// work must run (e.g. a conversation scene line) rather than be dropped.
export async function acquire(agentId: AgentId): Promise<() => void> {
  if (!held.has(agentId)) {
    held.add(agentId);
    return makeRelease(agentId);
  }
  await new Promise<void>((resolve) => {
    const q = waiters.get(agentId) ?? [];
    q.push(resolve);
    waiters.set(agentId, q);
  });
  held.add(agentId);
  return makeRelease(agentId);
}

export function isLocked(agentId: AgentId): boolean {
  return held.has(agentId);
}

function makeRelease(agentId: AgentId): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(agentId);
    const q = waiters.get(agentId);
    const next = q?.shift();
    if (q && q.length === 0) waiters.delete(agentId);
    if (next) next();
  };
}
