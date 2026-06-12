// Paced scenes as a step machine (design doc §3.1, §8C). A scene is an
// agent↔agent dialogue that advances in REAL TIME — one line at a time, with a
// 2–4s gap between lines (scaled by length, snappy per Thomas) — so a visitor
// can overhear it live and interject mid-scene.
//
// The old burst loop (all turns generated in seconds, replayed later) made
// "join in" structurally impossible and bunched feed timestamps. This rebuild
// is a module-level registry of SceneState advanced by self-rescheduling
// setTimeout steps, like the scheduler. Each step:
//   1. checks `interrupted` at the boundary — if set, exits via the CONVERTED
//      branch (engagement already handed to the chat session; never .ended);
//   2. tryAcquires ONLY the current speaker's agent-lock around speakLine +
//      addTurn (held seconds, not minutes — no tick starvation);
//   3. schedules the next step after a length-scaled gap.
// Engagement {kind:'scene'} marks BOTH participants busy for the scene's
// duration; the scheduler skip-logs them as `engaged:scene`. The natural-end
// teardown clears engagement + endConversation; the interrupted path does NOT
// release to the scheduler (the chat session now owns both agents).
//
// runTick fire-and-forgets sceneRunner.start (its own try/catch, its own
// Langfuse trace), so /admin/tick returns immediately and scene LLM calls are
// traced rather than orphaned.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AgentId, LocationId } from "@town/contract";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS } from "./client.js";
import { getProfile } from "./roles.js";
import {
  startConversation,
  addTurn,
  endConversation,
  closeConversationRow,
} from "../engine/conversations.js";
import { getAgent, setEngagement, clearEngagement } from "../engine/agents.js";
import { agentsAtLocation } from "../engine/locations.js";
import { appendEvent } from "../engine/events.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { tryAcquire } from "./agent-lock.js";
import { startTrace } from "./tracing.js";

// How many lines each participant may speak before the scene wraps naturally.
const MAX_TURNS_EACH = 6;

// Gap before the NEXT line, scaled by the line just spoken — snappy (Thomas's
// call, 2026-06-12): a short quip → ~2s, a longer paragraph → ~4s. Bounded to
// [MIN, MAX] so a one-word line still reads as a beat and a wall of text doesn't
// stall the scene. Pure so the scaling is unit-testable.
export const GAP_MIN_MS = 2_000;
export const GAP_MAX_MS = 4_000;
export function gapForLine(text: string): number {
  // ~per-char ramp: empty/short → MIN, ~200+ chars → MAX. Linear in length.
  const span = GAP_MAX_MS - GAP_MIN_MS;
  const frac = Math.min(1, text.length / 200);
  return Math.round(GAP_MIN_MS + span * frac);
}

export interface Line {
  agent: AgentId;
  text: string;
}

// One live scene in the registry (design doc §3.1).
export interface SceneState {
  conversationId: string;
  participants: [AgentId, AgentId];
  location: LocationId;
  lines: Line[];
  // CAS-set true by the interject handler; checked at every step boundary.
  interrupted: boolean;
  // The chat session the scene was converted INTO (interject). Set with
  // `interrupted` in one CAS so the step loop takes the converted branch.
  convertedTo: string | null;
  // Aborts any in-flight messages.create when interrupted (request `signal`).
  abort: AbortController;
  // The armed step timer (cleared on teardown / convert).
  timer: NodeJS.Timeout | null;
}

// Module-level registry: conversationId → live scene.
const scenes = new Map<string, SceneState>();

export function getScene(conversationId: string): SceneState | undefined {
  return scenes.get(conversationId);
}

// Find the live scene a given agent is currently in (used by the chat-join /
// interject path, which knows the conversationId; this is a convenience for
// callers that only have an agent). Returns the first match.
export function sceneForAgent(agentId: AgentId): SceneState | undefined {
  for (const s of scenes.values()) {
    if (s.participants.includes(agentId)) return s;
  }
  return undefined;
}

// Render the scene-so-far as the user-turn prompt for the next speaker.
function scenePrompt(speaker: AgentId, other: AgentId, location: LocationId, lines: Line[]): string {
  const transcript =
    lines.length === 0
      ? "(The conversation is just starting — you opened it.)"
      : lines.map((l) => `${l.agent === speaker ? "You" : l.agent}: ${l.text}`).join("\n");
  return [
    `## A conversation`,
    `You're at the ${location}, talking face-to-face with ${other}.`,
    ``,
    `## So far`,
    transcript,
    ``,
    `Say your next line — natural, in your voice, one turn. Keep it to a few sentences. ` +
      `If the conversation has reached a natural end, you may end with "[done]" on its own line and the scene will close.`,
  ].join("\n");
}

// One dialogue line from `speaker`. Returns the text (and whether they signalled
// done). No tools — pure speech. The abort signal cancels the call when the
// scene is interrupted mid-flight (design doc §3.1).
async function speakLine(
  speaker: AgentId,
  other: AgentId,
  location: LocationId,
  lines: Line[],
  sceneId: string,
  signal: AbortSignal,
): Promise<{ text: string; done: boolean }> {
  const profile = getProfile(speaker);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: scenePrompt(speaker, other, location, lines) },
  ];
  const res = await anthropic.beta.messages.create(
    {
      model: profile.role.tickModel,
      max_tokens: 512,
      system: systemBlocks(speaker),
      messages,
      betas: [...TICK_BETAS],
    },
    { signal },
  );
  const t = tokensFromUsage(res.usage);
  await recordUsage({
    agentId: speaker,
    model: profile.role.tickModel,
    tickId: `scene-${sceneId}`,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    estCostUsd: estimateCostUsd(profile.role.tickModel, t),
  });
  if (res.stop_reason === "refusal") return { text: "", done: true };
  const raw = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const done = /\[done\]\s*$/i.test(raw);
  const text = raw.replace(/\[done\]\s*$/i, "").trim();
  return { text, done };
}

// Start a paced scene between `initiator` and `target` at `location` (design doc
// §3.1). Fire-and-forget from runTick: own try/catch, own Langfuse trace. Returns
// the conversationId on success, or null if the scene couldn't start (target not
// co-located / engaged, or a lock was held). NEVER throws.
export async function start(
  initiator: AgentId,
  target: AgentId,
  location: LocationId,
): Promise<string | null> {
  if (!hasLlm()) return null;
  const [a, b, here] = await Promise.all([
    getAgent(initiator),
    getAgent(target),
    agentsAtLocation(location),
  ]);
  if (!a || !b) return null;
  if (!here.some((x) => x.id === target)) return null;
  // Don't barge into an engaged participant (in a chat/scene already).
  if (b.engagement || a.engagement) return null;

  const conversation = await startConversation(location, [initiator, target]);
  const conversationId = conversation.id;
  // Engagement marks BOTH busy for the scene's duration (cleared on teardown /
  // handed off on convert). Set BEFORE the first step so a concurrent tick can't
  // slip in. clearEngagement keys on (kind,id) so it frees both at once.
  await setEngagement("scene", conversationId, [initiator, target]);

  const state: SceneState = {
    conversationId,
    participants: [initiator, target],
    location,
    lines: [],
    interrupted: false,
    convertedTo: null,
    abort: new AbortController(),
    timer: null,
  };
  scenes.set(conversationId, state);

  // Own Langfuse trace for the whole scene (design doc §3.1) — scene LLM calls
  // are no longer orphaned from tracing now that runTick fire-and-forgets us.
  const trace = startTrace("scene", {
    userId: initiator,
    sessionId: utcDay(),
    metadata: { conversationId, participants: state.participants, location },
  });

  // Drive the step machine. The speaking order alternates; `step` reschedules
  // itself after a length-scaled gap until natural end or interruption.
  await runScene(state, trace);
  return conversationId;
}

// The step loop (design doc §3.1). Self-rescheduling: each step speaks one line
// (lock held only around speakLine + addTurn), then arms the next step after a
// gap. Checks `interrupted` at every boundary.
async function runScene(state: SceneState, trace: ReturnType<typeof startTrace>): Promise<void> {
  const [initiator, target] = state.participants;
  // Speaker order across the whole scene: initiator, target, initiator, ...
  const order: AgentId[] = [];
  for (let round = 0; round < MAX_TURNS_EACH; round++) order.push(initiator, target);
  let idx = 0;

  const finishNatural = async () => {
    state.timer = null;
    scenes.delete(state.conversationId);
    try {
      await endConversation(state.conversationId);
      await clearEngagement("scene", state.conversationId);
    } catch (err) {
      console.warn(`[scene ${state.conversationId}] teardown error:`, (err as Error).message);
    }
    trace.end({ lines: state.lines.length, ended: "natural" });
  };

  const finishConverted = async () => {
    state.timer = null;
    scenes.delete(state.conversationId);
    // Emit conversation.converted — NEVER conversation.ended. Engagement is
    // handed to the chat session by the interject handler (atomic with the CAS),
    // so we do NOT clearEngagement here and do NOT release to the scheduler.
    try {
      // Close the conversation ROW (no .ended event) so it leaves the snapshot's
      // activeConversations, then emit the converted signal.
      await closeConversationRow(state.conversationId);
      await appendEvent({
        type: "conversation.converted",
        locationId: state.location,
        visibility: "location",
        payload: { conversationId: state.conversationId },
      });
    } catch (err) {
      console.warn(`[scene ${state.conversationId}] convert emit failed:`, (err as Error).message);
    }
    trace.end({ lines: state.lines.length, ended: "converted", session: state.convertedTo });
  };

  // One step: speak the current line, then schedule the next (or finish).
  const step = async (): Promise<void> => {
    // Boundary check 1: interrupted before we even start this line.
    if (state.interrupted) return void (await finishConverted());
    if (idx >= order.length) return void (await finishNatural());

    const speaker = order[idx];
    const other = speaker === initiator ? target : initiator;

    // Acquire ONLY the speaker's lock, around the LLM call + addTurn. A tick for
    // the OTHER agent can run between steps — engagement (not the lock) is what
    // keeps them out of a scheduled idle tick.
    const release = tryAcquire(speaker);
    if (!release) {
      // Speaker momentarily locked (a tick raced in). Re-try this same step
      // shortly rather than skipping their line.
      armNext(GAP_MIN_MS);
      return;
    }
    let done = false;
    try {
      const res = await speakLine(speaker, other, state.location, state.lines, state.conversationId, state.abort.signal);
      done = res.done;
      if (res.text) {
        state.lines.push({ agent: speaker, text: res.text });
        await addTurn(state.conversationId, speaker, res.text);
      }
      if (!res.text) done = true; // empty line (e.g. refusal) ends the scene
    } catch (err) {
      // An abort is the EXPECTED interruption path — fall through to the
      // boundary check below, which takes the converted branch.
      if (!state.interrupted) {
        console.warn(`[scene ${state.conversationId}] line error:`, (err as Error).message);
        done = true; // unexpected error → wrap up naturally
      }
    } finally {
      release();
    }

    // Boundary check 2: interrupted DURING the line (the abort fired).
    if (state.interrupted) return void (await finishConverted());
    if (done) return void (await finishNatural());

    idx++;
    const gap = gapForLine(state.lines[state.lines.length - 1]?.text ?? "");
    armNext(gap);
  };

  const armNext = (ms: number): void => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void step().catch((err) =>
        console.warn(`[scene ${state.conversationId}] step crashed:`, (err as Error).message),
      );
    }, ms);
  };

  // Kick the first line immediately (no opening gap).
  await step();
}

// Interrupt a live scene and convert it to a group chat (design doc §3.1, §3.3a).
// Returns true iff this caller won the CAS (the scene existed and wasn't already
// converted). The caller MUST have already transferred engagement to the chat
// session BEFORE calling this — we only flip the flags + fire the abort; the
// step loop's converted branch emits conversation.converted and does NOT touch
// engagement. A lost race (already converted / scene gone) returns false → 409.
export function convertScene(conversationId: string, sessionId: string): boolean {
  const state = scenes.get(conversationId);
  if (!state) return false;
  if (state.convertedTo || state.interrupted) return false; // already won by someone
  // CAS: flip both together so the step loop takes the converted branch.
  state.convertedTo = sessionId;
  state.interrupted = true;
  // Fire the abort to cancel any in-flight messages.create; clear the armed
  // timer so the next step doesn't run before the in-flight one settles. The
  // in-flight step's finally releases the lock, then its boundary check sees
  // interrupted and finishes via the converted branch.
  state.abort.abort();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
    // If no step is in flight (timer was armed, nothing running), drive the
    // converted finish on the next tick so engagement/events settle.
    void finishConvertedNow(conversationId);
  }
  return true;
}

// When convertScene cancels an ARMED (not in-flight) step, there's no running
// step to reach the boundary check, so emit conversation.converted + tear down
// the registry entry here. Idempotent: a no-op if the scene already left the map.
async function finishConvertedNow(conversationId: string): Promise<void> {
  const state = scenes.get(conversationId);
  if (!state) return;
  scenes.delete(conversationId);
  try {
    await closeConversationRow(conversationId);
    await appendEvent({
      type: "conversation.converted",
      locationId: state.location,
      visibility: "location",
      payload: { conversationId },
    });
  } catch (err) {
    console.warn(`[scene ${conversationId}] convert emit failed:`, (err as Error).message);
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// Test seam (no DB / no LLM): inject a live scene into the registry so the
// convert/CAS transitions can be unit-tested. Returns the state so a test can
// inspect it. Not used in production paths.
export function _registerSceneForTest(state: SceneState): void {
  scenes.set(state.conversationId, state);
}

// Test seam: build a minimal SceneState with sane defaults.
export function _makeSceneStateForTest(
  conversationId: string,
  participants: [AgentId, AgentId],
): SceneState {
  return {
    conversationId,
    participants,
    location: "library",
    lines: [],
    interrupted: false,
    convertedTo: null,
    abort: new AbortController(),
    timer: null,
  };
}
