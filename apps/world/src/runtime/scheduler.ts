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
import { runTick } from "./tick.js";
import { runReflection } from "./reflection.js";
import { isOvernight, currentPhase } from "./clock.js";
import { appendEvent } from "../engine/events.js";
import { db, schema } from "../db/client.js";
import { gt, sql } from "drizzle-orm";
import { syncVault, pushAgentNotes } from "./vault.js";

const { visitors } = schema;

// Rate multipliers applied to each agent's base cadence (plan §4.1):
//   visitors present  → ~3x faster
//   overnight         → ~2x slower
const VISITOR_BOOST = 1 / 3;
const OVERNIGHT_SLOWDOWN = 2;

let running = false;
const timers = new Map<AgentId, NodeJS.Timeout>();
// Per-agent guard against the once-nightly reflection firing repeatedly.
const lastReflectionDay = new Map<AgentId, string>();
let lastPhase = "";

async function visitorsPresent(): Promise<boolean> {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(visitors)
    .where(gt(visitors.lastSeenAt, cutoff));
  return Number(row?.n ?? 0) > 0;
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

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// The per-agent loop body: maybe reflect (overnight, once/day), else tick.
async function tickAgent(agentId: AgentId): Promise<void> {
  try {
    if (isOvernight() && lastReflectionDay.get(agentId) !== utcDay()) {
      lastReflectionDay.set(agentId, utcDay());
      await runReflection(agentId);
      return;
    }
    await runTick(agentId);
  } catch (err) {
    console.warn(`[scheduler] tick ${agentId} threw:`, (err as Error).message);
  }
}

function scheduleNext(agentId: AgentId): void {
  if (!running) return;
  void nextDelayMs(agentId).then((ms) => {
    if (!running) return;
    const timer = setTimeout(async () => {
      await tickAgent(agentId);
      scheduleNext(agentId);
    }, ms);
    timers.set(agentId, timer);
  });
}

// Emit a world.time event when the day phase changes (frontend day/night tint).
async function emitPhaseIfChanged(): Promise<void> {
  const phase = currentPhase();
  if (phase !== lastPhase) {
    lastPhase = phase;
    await appendEvent({ type: "world.time", visibility: "public", payload: { phase } });
  }
}

let phaseTimer: NodeJS.Timeout | null = null;
let vaultTimer: NodeJS.Timeout | null = null;

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
}
