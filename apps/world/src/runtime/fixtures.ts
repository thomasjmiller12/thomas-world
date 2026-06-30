// Pure helpers for `use_fixture` (design doc §4): the fixture/action whitelist
// check and the per-agent effect rate limiter. Kept DB-free so both are
// trivially unit-testable; the tool in tools.ts wires them to live location
// rows and the world event log.

import type { AgentId } from "@town/contract";

// A fixture row as seeded on `locations.fixtures` (design doc §4 / seed.ts). The
// `actions` array is the whitelist of what an agent may do to it; absent/empty
// means the fixture is decorative and can't be acted on via use_fixture.
export interface FixtureDef {
  id: string;
  kind?: string;
  note?: string;
  actions?: string[];
}

export type FixtureCheck =
  | { ok: true; fixture: FixtureDef; action: string }
  | { ok: false; reason: string };

// Validate that `fixture` exists at the current location AND declares `action`
// in its whitelist. Returns an in-fiction reason on failure (the tool surfaces
// it verbatim — a normal tool result, not a thrown error, per §4 / tools.ts).
// `locationName` is for nicer copy ("here at The Office").
export function checkFixtureAction(
  fixtures: FixtureDef[],
  fixture: string,
  action: string,
  locationName: string,
): FixtureCheck {
  const f = fixtures.find((x) => x.id === fixture);
  if (!f) {
    const here = fixtures.map((x) => x.id).join(", ");
    return {
      ok: false,
      reason: `There's no ${fixture} here at ${locationName}. What's here: ${here || "nothing you can touch"}.`,
    };
  }
  const actions = f.actions ?? [];
  if (actions.length === 0) {
    return {
      ok: false,
      reason: `The ${fixture} isn't something you can mess with — it just sits there.`,
    };
  }
  if (!actions.includes(action)) {
    return {
      ok: false,
      reason: `You can't ${action} the ${fixture}. The most you can do with it: ${actions.join(", ")}.`,
    };
  }
  return { ok: true, fixture: f, action };
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
