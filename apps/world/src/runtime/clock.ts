// The world clock (plan §4.1). Maps real UTC time to a day phase and tells the
// scheduler whether it's "overnight" (slow ticks) or daytime. Phase changes are
// emitted as world.time events so the frontend can tint day/night.

import type { DayPhase } from "@town/contract";

// Hour-of-day → phase. Uses the server's local time (Railway runs UTC; the
// town's "day" tracks that — it's a fiction, not a real timezone).
export function phaseForHour(hour: number): DayPhase {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

export function currentPhase(now = new Date()): DayPhase {
  return phaseForHour(now.getHours());
}

// Overnight = the slow window where agents "sleep" and reflection runs.
export function isOvernight(now = new Date()): boolean {
  const phase = currentPhase(now);
  return phase === "night";
}

// A human-readable time-of-day line for the observation packet (NOT a raw
// timestamp — that would live below the cache breakpoint anyway, but the phase
// + clock time read better to the agent than an ISO string).
export function clockLine(now = new Date()): string {
  const phase = currentPhase(now);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${phase}, around ${hh}:${mm}`;
}
