// The Director/Effect protocol dispatcher (Phase A). One spine tool —
// `play_beat({ beat, object?, params })` — routes a NAMED, validated catalog
// beat (@town/contract `BEATS`) to one of two surfaces:
//
//   surface:"object"  → mutate a world_object's visible state (phone rings, lamp
//     flickers) via setObjectState (canonical `object.state_changed` for
//     perception) AND dual-emit the existing `world.effect` so the proven
//     frontend sprite path plays unchanged. A "ring" beat records a pending call
//     so a visitor who answers wakes the ringer live.
//   surface:"screen"  → cross the glass onto the visitor's client (popup card,
//     emote) via a new `world.beat` event, directed at the resolved target
//     visitor (chat visitor, or the most-recent local interactor, or room-wide).
//
// The agent can never inject markup — it can only sequence catalog beats, and
// every param is validated server-side against the beat's zod schema. Beats
// share `leave_note`'s 20/hr effect limiter (fixtures.ts, the anti-grind knob
// every flourish draws from) so they can't become a fidget, PLUS a separate
// per-visitor pacing budget for directed screen beats (below). Every path
// returns an IN-FICTION string — we never throw to the model (a thrown error
// would corrupt the agent's turn).

import { getBeat, listBeats, type AgentId, type BeatDef } from "@town/contract";
import type { AgentContext } from "./tools.js";
import { tryRecordEffect } from "./fixtures.js";
import { findObjectAtLocation, objectsAtLocation, setObjectState } from "../engine/objects.js";
import { appendEvent, eventsOfTypes } from "../engine/events.js";
import { getSession } from "./chat.js";

// --- pending-call registry --------------------------------------------------
// A "ring" object beat records a pending call so that when a visitor answers the
// ringing object, the agent who rang it wakes immediately to run the bit. Same
// lifetime/idiom as fixtures.ts `effectTimestamps` (module-level, in-memory,
// resets on restart — a dropped pending call is acceptable, the same class as
// the effect limiter). One-shot consume, TTL'd.
const PENDING_TTL_MS = 10 * 60_000;
interface PendingCall {
  agentId: AgentId;
  ts: number;
}
const pendingCalls = new Map<string, PendingCall>();

// One-shot consume: returns + removes the pending call for an object if it's
// still within the TTL window; otherwise null (and prunes a stale entry).
// `now` is injectable for deterministic tests.
export function consumePendingCall(
  objectId: string,
  now: number = Date.now(),
): { agentId: AgentId } | null {
  const call = pendingCalls.get(objectId);
  if (!call) return null;
  pendingCalls.delete(objectId); // one-shot regardless of freshness
  if (now - call.ts > PENDING_TTL_MS) return null; // stale → as if absent
  return { agentId: call.agentId };
}

// Arm a pending call on an object: whoever answers it (a visitor clicking the
// ringing phone → visitor.interacted) wakes `agentId` live to run the bit.
function recordPendingCall(objectId: string, agentId: AgentId, now: number = Date.now()): void {
  pendingCalls.set(objectId, { agentId, ts: now });
}

// Test seam so the module-level registry doesn't leak between specs.
export function _resetPendingCalls(): void {
  pendingCalls.clear();
}

// --- per-visitor pacing budget (Phase B) ------------------------------------
// A separate, smaller knob from fixtures.ts's per-AGENT 20/hr limiter: this one
// tracks how many DIRECTED screen beats have landed on one VISITOR recently,
// regardless of which agent fired them, so a visitor can't be bombarded by the
// whole cast in turn. Same in-memory/module-level idiom as the effect limiter.
const VISITOR_PACE_WINDOW_MS = 10 * 60_000;
const VISITOR_PACE_MAX = 4;
const visitorBeatTimestamps = new Map<string, number[]>();

function tryRecordVisitorBeat(visitorId: string, now: number = Date.now()): boolean {
  const cutoff = now - VISITOR_PACE_WINDOW_MS;
  const recent = (visitorBeatTimestamps.get(visitorId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= VISITOR_PACE_MAX) {
    visitorBeatTimestamps.set(visitorId, recent); // prune even on rejection
    return false;
  }
  recent.push(now);
  visitorBeatTimestamps.set(visitorId, recent);
  return true;
}

// Test seam so the module-level pacing map doesn't leak between specs.
export function _resetVisitorPacing(): void {
  visitorBeatTimestamps.clear();
}

// --- target-visitor resolution (screen beats) -------------------------------
// Who does a screen beat reach? The chat visitor if this turn is a chat reply;
// else the most-recent visitor who `interacted` at this location within ~2 min
// (e.g. the person who just answered the phone); else null (room-wide). Returns
// null on any lookup failure — a screen beat still fires room-wide.
const RECENT_INTERACT_MS = 2 * 60_000;
async function resolveTargetVisitor(
  ctx: AgentContext,
  now: number = Date.now(),
): Promise<string | null> {
  if (ctx.chatSessionId) {
    const session = await getSession(ctx.chatSessionId).catch(() => null);
    if (session?.visitorId) return session.visitorId;
  }
  // Most-recent visitor.interacted here, within the window.
  const events = await eventsOfTypes(["visitor.interacted"], 40).catch(() => []);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.locationId !== ctx.location) continue;
    const ts = new Date(e.ts).getTime();
    if (now - ts > RECENT_INTERACT_MS) continue;
    const vid = (e.payload as { visitorId?: unknown }).visitorId;
    if (typeof vid === "string" && vid) return vid;
  }
  return null;
}

// --- the dispatcher ---------------------------------------------------------

export interface PlayBeatArgs {
  beat: string;
  object?: string;
  params: Record<string, unknown>;
}

// Pick a sensible default object when a surface:"object" beat omits `object`.
// The world_objects.affordances column is seeded straight from each fixture's
// `actions` whitelist (db/seed.ts), so it already names exactly which object(s)
// here support a given effect — match on that first (works for any beat whose
// effect lines up with a fixture affordance: ring/flicker/hiss/rustle alike, no
// per-effect special-casing). Falls back to the first device, else the first
// object here, for beats/locations where affordances aren't populated (tests,
// future templates).
function defaultObjectRef(
  beatDef: BeatDef,
  here: { displayName: string; kind: string | null; affordances?: string[] | null }[],
): string | null {
  if (beatDef.effect) {
    const byAffordance = here.find((o) => (o.affordances ?? []).includes(beatDef.effect!));
    if (byAffordance) return byAffordance.displayName;
  }
  const devices = here.filter((o) => o.kind === "device");
  if (devices.length > 0) return devices[0].displayName;
  if (here.length > 0) return here[0].displayName;
  return null;
}

export async function playBeat(ctx: AgentContext, args: PlayBeatArgs): Promise<string> {
  const beatDef = getBeat(args.beat);
  if (!beatDef) {
    const names = listBeats()
      .map((b) => b.id)
      .join(", ");
    return `There's no bit called "${args.beat}". The bits you can run: ${names}.`;
  }

  // Validate params against the beat's own schema (in-fiction error on failure).
  const parsed = beatDef.params.safeParse(args.params ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `"${issue.path.join(".")}": ` : "";
    return `That ${beatDef.label.toLowerCase()} won't go — ${where}${issue?.message ?? "the details don't fit"}.`;
  }
  const params = parsed.data as Record<string, unknown>;

  // Rate-limit AFTER validation (a malformed call shouldn't burn a slot). Shares
  // the same per-agent effect limiter as leave_note so beats can't become a fidget.
  if (!tryRecordEffect(ctx.agentId)) {
    return `You've been pulling a lot of bits lately — let it breathe. A bit that lands once beats five that don't.`;
  }

  if (beatDef.surface === "object") {
    return runObjectBeat(ctx, beatDef, args.object, params);
  }
  return runScreenBeat(ctx, beatDef, params);
}

async function runObjectBeat(
  ctx: AgentContext,
  beatDef: BeatDef,
  objectRef: string | undefined,
  _params: Record<string, unknown>,
): Promise<string> {
  const here = await objectsAtLocation(ctx.location).catch(() => []);
  const ref = objectRef ?? defaultObjectRef(beatDef, here) ?? undefined;
  const obj = ref ? await findObjectAtLocation(ctx.location, ref).catch(() => undefined) : undefined;
  if (!obj) {
    const names = here.map((o) => o.displayName).join(", ");
    return objectRef
      ? `There's no "${objectRef}" here to do that to. What's here: ${names || "nothing"}.`
      : `There's nothing here you can run "${beatDef.label.toLowerCase()}" on right now.`;
  }

  const effect = beatDef.effect ?? "effect";
  const res = await setObjectState(obj.id, ctx.agentId, effect, beatDef.statePatch).catch(
    (err): { ok: boolean; reason?: string } => ({ ok: false, reason: (err as Error).message }),
  );
  if (!res.ok) {
    return `You couldn't make the ${obj.displayName} react just now. Try again in a moment.`;
  }

  // DUAL-EMIT the existing world.effect so the proven frontend sprite path plays
  // unchanged (the canonical object.state_changed rode out of setObjectState for
  // perception + state). Object-effect double-render is avoided because the
  // frontend keeps object.state_changed at [] (it renders only world.effect).
  await appendEvent({
    type: "world.effect",
    agentId: ctx.agentId,
    locationId: ctx.location,
    visibility: "public",
    payload: { location: ctx.location, fixture: obj.displayName, effect, agent: ctx.agentId },
  });

  // A "ring" records a pending call: whoever answers wakes this agent live.
  if (effect === "ring") {
    recordPendingCall(obj.id, ctx.agentId);
  }

  await ctx.onAction?.("play_beat", `runs the ${beatDef.label.toLowerCase()}`);
  return `You run the bit — the ${obj.displayName} ${effect}s. Anyone here notices.`;
}

async function runScreenBeat(
  ctx: AgentContext,
  beatDef: BeatDef,
  params: Record<string, unknown>,
): Promise<string> {
  // audience:"room" screen beats (e.g. emote) render to everyone → visitorId null.
  // audience:"visitor" beats resolve a specific target (chat visitor / recent
  // interactor), falling back to room-wide only when no one is resolvable.
  const visitorId =
    beatDef.audience === "room" ? null : await resolveTargetVisitor(ctx).catch(() => null);

  // Per-visitor pacing budget (Façade concern, Phase B): the agent-level 20/hr
  // knob caps any ONE agent's fidgeting, but a visitor could still get bombarded
  // by several DIFFERENT agents' directed beats in one visit. Gate only a
  // resolved, directed target — room-wide audience:"room" beats (emote) aren't
  // aimed at anyone in particular and stay on the agent-level budget alone.
  if (visitorId && !tryRecordVisitorBeat(visitorId)) {
    return `This visitor's had a few bits land on their screen already — let this one go. A bit that lands once beats five that don't, and that goes double from their side.`;
  }

  await appendEvent({
    type: "world.beat",
    agentId: ctx.agentId,
    locationId: ctx.location,
    visitorId,
    visibility: "location",
    payload: {
      beat: beatDef.id,
      agent: ctx.agentId,
      location: ctx.location,
      objectId: null,
      visitorId,
      params,
    },
  });

  await ctx.onAction?.("play_beat", `runs the ${beatDef.label.toLowerCase()}`);
  return beatDef.audience === "room"
    ? `You run the bit — everyone here sees it.`
    : visitorId
      ? `You run the bit — it lands on the visitor's screen.`
      : `You run the bit — it plays to the room.`;
}
