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
import { runTick, budgetExceeded } from "./tick.js";
import { runReflection } from "./reflection.js";
import { isOvernight, currentPhase } from "./clock.js";
import { appendEvent } from "../engine/events.js";
import { getAgent } from "../engine/agents.js";
import { spendTodayUsd, spendTodayForAgent } from "../engine/usage.js";
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
//   visitors present  → ~3x faster
//   overnight         → ~2x slower
const VISITOR_BOOST = 1 / 3;
const OVERNIGHT_SLOWDOWN = 2;

let running = false;
const timers = new Map<AgentId, NodeJS.Timeout>();
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
  if (await visitorsPresent()) mult *= VISITOR_BOOST;
  if (isOvernight()) mult *= OVERNIGHT_SLOWDOWN;
  // Jitter ±15% so agents don't lockstep even at equal cadence.
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.max(30_000, Math.round(base * mult * jitter));
}

// Whether the agent or the world is over budget right now. Reflection routes
// AROUND runTick (which carries its own budget gate), so we must re-check here or
// a budget-exhausted agent would still spend a full reflection tick each night.
async function overBudget(agentId: AgentId): Promise<boolean> {
  try {
    const profile = getProfile(agentId);
    const [globalSpend, agentSpend] = await Promise.all([
      spendTodayUsd(),
      spendTodayForAgent(agentId),
    ]);
    return budgetExceeded({
      globalSpendUsd: globalSpend,
      globalCapUsd: config.dailyBudgetUsd,
      agentSpendUsd: agentSpend,
      agentCapUsd: profile.role.dailyTokenBudgetUsd,
    });
  } catch (err) {
    // On a metering error, fail safe by NOT spending (skip reflection).
    console.warn(`[scheduler] budget check ${agentId} failed:`, (err as Error).message);
    return true;
  }
}

// The per-agent loop body: maybe reflect (once per night session), else tick.
async function tickAgent(agentId: AgentId): Promise<void> {
  try {
    if (isOvernight() && !reflectedThisNight.has(agentId)) {
      if (await overBudget(agentId)) return; // honor the daily cap for reflection too
      // Mark reflected only on SUCCESS (design doc §3.2): a reflection skipped
      // because the agent was locked/engaged should retry on the next loop,
      // not be lost for the whole night session.
      const { ran } = await runReflection(agentId);
      if (ran) reflectedThisNight.add(agentId);
      return;
    }
    await runTick(agentId);
  } catch (err) {
    console.warn(`[scheduler] tick ${agentId} threw:`, (err as Error).message);
  }
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
      const timer = setTimeout(() => {
        // tickAgent never throws (it has its own try/catch), but guard the
        // reschedule with finally so an unexpected synchronous throw can't strand it.
        void tickAgent(agentId).finally(() => scheduleNext(agentId));
      }, ms);
      timers.set(agentId, timer);
    });
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
    const timer = setTimeout(async () => {
      await tickAgent(id);
      scheduleNext(id);
    }, stagger);
    timers.set(id, timer);
  });

  // World clock: check the phase every minute, emit on change.
  phaseTimer = setInterval(() => void emitPhaseIfChanged(), 60_000);
  void emitPhaseIfChanged();

  // Auto-close abandoned chat sessions every 5 min so a tab-closed-without-close
  // never strands an agent busy=true (and skipped) for the rest of the soak.
  chatSweepTimer = setInterval(() => {
    void sweepStaleChats().catch((err) =>
      console.warn("[scheduler] chat sweep failed:", (err as Error).message),
    );
  }, 5 * 60_000);

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
  if (phaseTimer) clearInterval(phaseTimer);
  if (vaultTimer) clearInterval(vaultTimer);
  if (chatSweepTimer) clearInterval(chatSweepTimer);
}
