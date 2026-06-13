// The world clock (plan §4.1). Maps wall time to a day phase and tells the
// scheduler whether it's "overnight" (slow ticks) or daytime. Phase changes are
// emitted as world.time events so the frontend can tint day/night.
//
// The town's day tracks TOWN_TIMEZONE (default America/Los_Angeles — Thomas's
// and most visitors' evening). It originally tracked the server clock, but
// Railway runs UTC, which put "night" (dream mode + 2x slowdown) at 3-10pm
// Pacific — the town slept through exactly the hours people visit.

import type { DayPhase } from "@town/contract";

const TOWN_TIMEZONE = process.env.TOWN_TIMEZONE ?? "America/Los_Angeles";

// Town-local hour/minute via Intl (DST-correct), with a guard for the h24
// "24:00" midnight quirk. Falls back to server time if the zone id is bad.
function townTime(now: Date): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      timeZone: TOWN_TIMEZONE,
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const hour = get("hour") % 24;
    const minute = get("minute");
    if (Number.isFinite(hour) && Number.isFinite(minute)) return { hour, minute };
  } catch {
    /* bad TOWN_TIMEZONE — fall through */
  }
  return { hour: now.getHours(), minute: now.getMinutes() };
}

// Hour-of-day (town-local) → phase.
export function phaseForHour(hour: number): DayPhase {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

export function currentPhase(now = new Date()): DayPhase {
  return phaseForHour(townTime(now).hour);
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
  const { hour, minute } = townTime(now);
  const phase = phaseForHour(hour);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${phase}, around ${hh}:${mm}`;
}
