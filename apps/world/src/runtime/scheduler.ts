// The scheduler (plan §4.1): staggered per-agent timers from roles/*.yaml,
// with a dynamic rate — faster while visitors are present, slower overnight —
// plus a once-per-night reflection tick per agent. In-process (single Node
// process = scheduler + API + SSE), matching the Railway monolith decision.
//
// Each agent gets its own self-rescheduling timer (not one global loop) so
// per-role cadence is honored and ticks stay staggered. We never run two ticks
// for the same agent concurrently (the timer reschedules only after the tick
// settles).

import { agentIds, type AgentId } from "@town/contract";
import { config } from "../config.js";
import { hasLlm } from "./client.js";
import { getProfile } from "./roles.js";
import { enqueue } from "./queue.js";
import { isOvernight, isActiveHours, currentPhase } from "./clock.js";
import { appendEvent } from "../engine/events.js";
import { db, schema } from "../db/client.js";
import { gt, sql } from "drizzle-orm";
import { syncVault, pushAgentNotes } from "./vault.js";
import { sweepStaleChats } from "./chat.js";

// Fallback cadence used only when computing the next delay itself fails (e.g. a
// transient DB error in the visitor-presence query). Keeps the agent rescheduling
// instead of going permanently dark.
const FALLBACK_DELAY_MS = 5 * 60_000;

const { visitors } = schema;

// Rate multipliers applied to each agent's base cadence (plan §4.1):
//   visitors present  → boost (faster)   — DISABLED for the soak (see below)
//   overnight         → ~2x slower
//
// VISITOR_BOOST is DISABLED (1 = no speed-up). It used to 3x every agent's tick
// rate whenever a visitor was "present" — but an open/forgotten browser tab keeps
// a visitor present indefinitely, so it silently tripled the burn (~$7/day idle →
// ~$20+/day with a tab left open; confirmed in the spend logs). Chat is
// interrupt-driven now, so visitors still get an immediate reply regardless of
// cadence — the boost only added autonomous churn while a tab was open. Restore
// to e.g. 1/2 (gentler) or 1/3 (original) when not cost-constrained.
const VISITOR_BOOST = 1;
const OVERNIGHT_SLOWDOWN = 2;

let running = false;
const timers = new Map<AgentId, NodeJS.Timeout>();
// When each agent's currently-armed timer is scheduled to fire (epoch ms). Lets
// boostAgent compute the remaining delay so a boost never *delays* a tick that
// was already due sooner than the boost target.
const nextFireAt = new Map<AgentId, number>();
// Boost throttle (design doc §2/§7): the default per-pair window for the visitor
// co-location boost — per (visitorId, agentId) at most one boost per 5 minutes,
// so a visitor pacing between rooms can't farm ticks. Say-boosts pass their own
// (tighter) window. Keyed by an explicit throttle key → last-boost epoch ms.
// In-memory (matches the single-process scheduler); cleared on restart, which is
// fine (a restart drops all armed timers anyway).
const BOOST_THROTTLE_MS = 5 * 60_000;
const lastBoostAt = new Map<string, number>();

// M3: emergent room talk no longer needs a say-boost timer. Speaking is plain
// text (loop.ts emitUtterance), and ADDRESSING a co-located facet by name pushes
// it an immediate (interrupt) tick from the loop. Ambient speech is picked up on
// the listener's next scheduled tick via its world delta (co-located notice-push).
// Per-agent guard so the once-nightly reflection fires once per NIGHT SESSION,
// not once per calendar day. The "night" phase straddles UTC midnight (hours
// >=22 OR <5), so a calendar-day key would let reflection fire again at 00:01.
// We instead mark the agent reflected and reset the marks only when the world
// phase leaves "night".
const reflectedThisNight = new Set<AgentId>();
let lastPhase = "";

async function visitorsPresent(): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - 2 * 60_000);
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(visitors)
      .where(gt(visitors.lastSeenAt, cutoff));
    return Number(row?.n ?? 0) > 0;
  } catch (err) {
    // A DB blip must not propagate into nextDelayMs and drop the reschedule.
    console.warn("[scheduler] visitorsPresent query failed:", (err as Error).message);
    return false;
  }
}

// Compute the next delay (ms) for an agent given its base cadence and the
// current world conditions.
async function nextDelayMs(agentId: AgentId): Promise<number> {
  const base = getProfile(agentId).role.tickCadenceMinutes * 60_000;
  let mult = 1;
  // Only pay for the visitor-presence query when the boost is actually enabled.
  if (VISITOR_BOOST !== 1 && (await visitorsPresent())) mult *= VISITOR_BOOST;
  if (isOvernight()) mult *= OVERNIGHT_SLOWDOWN;
  // Jitter ±15% so agents don't lockstep even at equal cadence.
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(30_000, Math.round(base * mult * jitter));
}

// The per-agent loop body: ENQUEUE a reflection (once per night session) or a
// passive tick. The queue (queue.ts) serializes it behind any in-flight or
// interrupt input; enqueue resolves when the input has actually been processed,
// so the reschedule (scheduleNext, via the timer's finally) still fires after
// the turn settles.
async function tickAgent(agentId: AgentId): Promise<void> {
  try {
    // Nightly reflection ALWAYS runs — exempt from both the budget cap and the
    // waking-hours window. It's the end-of-day ritual (diary + core-memory
    // curation), cheap and important; we never want to skip it. Reflection's own
    // DB-grounded idempotency keeps it to once per night.
    if (isOvernight() && !reflectedThisNight.has(agentId)) {
      const { ran } = await enqueue(agentId, { kind: "reflection" });
      if (ran) reflectedThisNight.add(agentId);
      return;
    }
    // Passive living happens only during the waking-hours window (cost lever).
    // Outside it the town is dormant — no autonomous ticks — but visitors can
    // still chat (interrupt-driven, enqueued by the HTTP layer, not gated here)
    // and reflection still fires overnight (above). The timer keeps rescheduling,
    // so ticks resume automatically when the window reopens.
    if (!isActiveHours()) return;
    await enqueue(agentId, { kind: "tick" });
  } catch (err) {
    console.warn(`[scheduler] tick ${agentId} threw:`, (err as Error).message);
  }
}

// Arm (or re-arm) the agent's timer to fire `ms` from now, recording the fire
// time so boostAgent can reason about the remaining delay. Replaces any timer
// currently armed for this agent.
function armTimer(agentId: AgentId, ms: number): void {
  const existing = timers.get(agentId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    nextFireAt.delete(agentId);
    // tickAgent never throws (it has its own try/catch), but guard the
    // reschedule with finally so an unexpected synchronous throw can't strand it.
    void tickAgent(agentId).finally(() => scheduleNext(agentId));
  }, ms);
  timers.set(agentId, timer);
  nextFireAt.set(agentId, Date.now() + ms);
}

function scheduleNext(agentId: AgentId): void {
  if (!running) return;
  // ALWAYS re-arm, even if the delay computation rejects. A single dropped
  // reschedule here (e.g. an unhandled rejection in nextDelayMs) would stop this
  // agent ticking for the rest of the soak with no error in the activity log.
  void nextDelayMs(agentId)
    .catch((err) => {
      console.warn(
        `[scheduler] nextDelayMs ${agentId} failed, using fallback:`,
        (err as Error).message,
      );
      return FALLBACK_DELAY_MS;
    })
    .then((ms) => {
      if (!running) return;
      armTimer(agentId, ms);
    });
}

// Decide whether a boost (co-location OR say) is allowed right now and, if so,
// the new delay to re-arm at. Pure so it's unit-testable (design doc §2):
//   - location-budget: the per-location say-boost budget is spent this hour
//   - throttled: a prior boost for this key landed within `throttleMs`
//   - no-timer: the agent has no armed timer to pull forward
//   - otherwise re-arm at min(remaining, jittered target ≤ maxDelayMs)
// A boost NEVER pushes the tick later than it was already due. The location
// budget is checked FIRST (a spent room stops boosting regardless of the pair
// throttle) so the storm cap is unconditional.
export interface BoostDecision {
  boost: boolean;
  reason?: "throttled" | "engaged" | "not-running" | "no-timer" | "location-budget";
  delayMs?: number;
}

export function decideBoost(args: {
  now: number;
  lastBoostAt: number | undefined;
  remainingMs: number | undefined;
  maxDelayMs: number;
  jitterMs: number; // a value in [0, maxDelayMs - floor) chosen by the caller
  floorMs?: number;
  // The throttle window for THIS boost's key (defaults to the 5-min visitor
  // window; say-boosts pass the tighter SAY_THROTTLE_MS).
  throttleMs?: number;
  // True iff the per-location say-boost budget is already spent this hour. The
  // caller computes it from the in-memory counter; absent/false for co-location
  // boosts (which aren't budgeted per location).
  locationBudgetExceeded?: boolean;
}): BoostDecision {
  const { now, lastBoostAt: last, remainingMs, maxDelayMs, jitterMs } = args;
  const floor = args.floorMs ?? 30_000;
  const throttleMs = args.throttleMs ?? BOOST_THROTTLE_MS;
  if (args.locationBudgetExceeded) return { boost: false, reason: "location-budget" };
  if (last !== undefined && now - last < throttleMs) {
    return { boost: false, reason: "throttled" };
  }
  if (remainingMs === undefined) return { boost: false, reason: "no-timer" };
  const target = Math.min(maxDelayMs, Math.max(floor, floor + jitterMs));
  // Never delay a tick that's already due sooner than the boost target.
  const delayMs = Math.max(0, Math.min(remainingMs, target));
  return { boost: true, delayMs };
}

// Generic tick boost (design doc §2). Pull an agent's next scheduled tick forward
// into a [floor, maxDelayMs] band so it reacts promptly to a visitor who just
// walked in — without farming ticks. Throttled per explicit `throttleKey` (an
// ordered pair) within `throttleMs`. The timer firing ENQUEUES a tick (queue.ts),
// which serializes behind anything in flight. Returns the decision (the visitor
// fan-out logs misses at debug; tests assert on the BoostDecision).
export async function boostAgent(
  agentId: AgentId,
  throttleKey: string,
  opts: {
    maxDelayMs?: number;
    floorMs?: number;
    throttleMs?: number;
    locationBudgetExceeded?: boolean;
  } = {},
): Promise<BoostDecision> {
  if (!running) return { boost: false, reason: "not-running" };

  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  const floor = opts.floorMs ?? 30_000;
  const armed = nextFireAt.get(agentId);
  const remainingMs = armed === undefined ? undefined : Math.max(0, armed - Date.now());
  // Jitter across the [floor, maxDelayMs] band so boosts don't lockstep.
  const jitterMs = Math.random() * Math.max(0, maxDelayMs - floor);
  const decision = decideBoost({
    now: Date.now(),
    lastBoostAt: lastBoostAt.get(throttleKey),
    remainingMs,
    maxDelayMs,
    jitterMs,
    floorMs: floor,
    throttleMs: opts.throttleMs,
    locationBudgetExceeded: opts.locationBudgetExceeded,
  });
  if (decision.boost && decision.delayMs !== undefined) {
    lastBoostAt.set(throttleKey, Date.now());
    armTimer(agentId, decision.delayMs);
    console.log(
      `[scheduler] boosted ${agentId} (${throttleKey}) → ${Math.round(decision.delayMs / 1000)}s.`,
    );
  }
  return decision;
}

// Test seam: reset the in-memory boost throttle (no effect on armed timers).
export function _resetBoostThrottleForTest(): void {
  lastBoostAt.clear();
}

// Emit a world.time event when the day phase changes (frontend day/night tint).
async function emitPhaseIfChanged(): Promise<void> {
  const phase = currentPhase();
  if (phase !== lastPhase) {
    // Leaving "night" → arm the next night's reflection for every agent.
    if (lastPhase === "night" && phase !== "night") reflectedThisNight.clear();
    lastPhase = phase;
    await appendEvent({ type: "world.time", visibility: "public", payload: { phase } });
  }
}

let phaseTimer: NodeJS.Timeout | null = null;
let vaultTimer: NodeJS.Timeout | null = null;
let chatSweepTimer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (running) return;
  if (!hasLlm()) {
    console.warn("[scheduler] ANTHROPIC_API_KEY absent — scheduler NOT started (no idle ticks).");
    return;
  }
  running = true;
  console.log(
    `[scheduler] starting: ${agentIds.length} agents, dynamic rate (visitor boost ${VISITOR_BOOST}x, overnight ${OVERNIGHT_SLOWDOWN}x).`,
  );

  // Stagger the initial ticks so all five don't fire at once: spread the first
  // tick of each agent across its base cadence window.
  agentIds.forEach((id, i) => {
    const base = getProfile(id).role.tickCadenceMinutes * 60_000;
    const stagger = Math.round((base / agentIds.length) * i) + 5_000;
    armTimer(id, stagger);
  });

  // World clock: check the phase every minute, emit on change. Initialized
  // silently — emitting on boot re-announced the current phase after every
  // restart/deploy (duplicate world.time in the feed); the frontend reads the
  // live phase from the snapshot anyway.
  lastPhase = currentPhase();
  phaseTimer = setInterval(() => void emitPhaseIfChanged(), 60_000);

  // Liveness-aware sweep (design doc §3.4): every minute, close sessions with no
  // ping AND no message for 3 min so a tab-closed-without-close never strands an
  // agent engaged for the rest of the soak — while a slow-typing / long-reading
  // visitor who keeps pinging is never cut off.
  chatSweepTimer = setInterval(() => {
    void sweepStaleChats().catch((err) =>
      console.warn("[scheduler] chat sweep failed:", (err as Error).message),
    );
  }, 60_000);

  // Vault sync: pull every ~10 min, push agent notes back (belt-and-suspenders
  // poll; the webhook path lands at deploy). No-op when the vault is unconfigured.
  if (config.features.vault) {
    const doSync = async () => {
      await syncVault();
      await pushAgentNotes();
    };
    void doSync();
    vaultTimer = setInterval(() => void doSync(), 10 * 60_000);
  }
}

export function stopScheduler(): void {
  running = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  nextFireAt.clear();
  if (phaseTimer) clearInterval(phaseTimer);
  if (vaultTimer) clearInterval(vaultTimer);
  if (chatSweepTimer) clearInterval(chatSweepTimer);
}
