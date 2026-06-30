// The per-agent effect rate limiter shared by `play_beat` (director.ts) and
// `leave_note` (tools.ts). Kept DB-free so it's trivially unit-testable. Also
// holds `FixtureDef`, the shape of a `locations.fixtures` row (design doc §4 /
// seed.ts) — still used by the visitor-interact endpoint (app.ts) to check a
// fixture exists at a location, even though the action-whitelist verb
// (`use_fixture`) it used to back is gone (those effects are catalog beats now;
// see packages/contract/src/beats.ts's lamp-flicker/espresso-hiss/board-rustle).
import type { AgentId } from "@town/contract";

export interface FixtureDef {
  id: string;
  kind?: string;
  note?: string;
  actions?: string[];
}

// In-memory effect rate limiter: 20 effects per rolling hour per agent (raised
// from 3 once beats/bits became a first-class, actively-demoed surface).
// Module-level so it survives across ticks within one server process (the same
// lifetime as the agent-lock map). Not persisted — a restart resets it, which
// is fine for an anti-spam knob.
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 20;
const effectTimestamps = new Map<AgentId, number[]>();

// Returns true and RECORDS the effect if under the limit; returns false (records
// nothing) when the agent has already hit 3 in the last hour. `now` is injectable
// for deterministic tests.
export function tryRecordEffect(agentId: AgentId, now: number = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  const recent = (effectTimestamps.get(agentId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= MAX_PER_WINDOW) {
    effectTimestamps.set(agentId, recent); // prune even on rejection
    return false;
  }
  recent.push(now);
  effectTimestamps.set(agentId, recent);
  return true;
}

// Test-only reset so the module-level limiter doesn't leak state between specs.
export function _resetEffectLimiter(): void {
  effectTimestamps.clear();
}
