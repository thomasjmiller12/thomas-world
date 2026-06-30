import { Events } from 'phaser';
import type { AgentId, DayPhase, LocationId, WorldEvent, ShareCard } from '@town/contract';
import type { ThomasId, ChatMessage } from '@/lib/types';

// The typed event taxonomy that flows over the EventBus — the seam between the
// world (WorldClient / dream mode) and the surfaces (Phaser canvas + React
// overlay). Names map near-1:1 to contract world events (design doc §6.1):
//   agent.moved      → npc-move-to
//   agent.thought    → npc-thought
//   agent.spoke      → npc-speech            (ambient/overheard)
//   agent.activity   → npc-activity
//   world.effect     → fixture-effect
// Snapshot hydration emits npc-status / world-state for initial UI state.
//
// Adding an event here gives `emit`/`on`/`off` full type-safety on payloads.
export interface WorldEvents {
  // --- Phaser lifecycle (canvas-owned) -------------------------------------
  'current-scene-ready': Phaser.Scene;
  'scene-changed': { scene: string; locationName: string; locationId?: LocationId };
  'player-interact': { x: number; y: number; direction: string };

  // --- proximity / interaction targeting (canvas → overlay) ----------------
  'npc-proximity-enter': { npcId: ThomasId };
  'npc-proximity-exit': { npcId: ThomasId };
  'npc-screen-position': { npcId: string; screenX: number; screenY: number };
  'npc-interaction': { npcId: ThomasId; npcName: string };

  // --- ambient world stream (WorldClient / dream mode → canvas+overlay) -----
  // An agent moved between locations (contract agent.moved).
  'npc-move-to': { npcId: ThomasId; from?: LocationId; to: LocationId; target?: { x: number; y: number } };
  // A public-safe thought wisp (contract agent.thought). `ts` is the event's ISO
  // timestamp so the overlay can pop a bubble only for LIVE events, not replayed
  // backlog (a reconnect/late-join replays recent events to catch the scene up —
  // those must update state without flooding the screen with stale bubbles).
  'npc-thought': { npcId: ThomasId; thought: string; ts?: string };
  // Overheard ambient speech (contract agent.spoke). `location` scopes the
  // bubble to the room; `ts` gates live-vs-replayed (see npc-thought); `id` is
  // the source event id so consumers (e.g. the room transcript) can de-dupe.
  'npc-speech': { npcId: ThomasId; message: string; audience: string; location?: LocationId; ts?: string; id?: string };
  // What an agent is currently doing (contract agent.activity).
  'npc-activity': { npcId: ThomasId; activity: string };
  // A set/fixture effect — phone rings, lamp flickers (contract world.effect).
  'fixture-effect': { location: LocationId; fixture: string; effect: string; npcId?: ThomasId };

  // --- per-agent live status (snapshot hydration + engagement flips) --------
  // Authoritative status for one agent: where it is, what it's doing, whether
  // it's engaged. Drives the roster + canvas spawn/despawn + sprite state.
  'npc-status': {
    npcId: ThomasId;
    locationId: LocationId;
    status: string;
    activity: string | null;
    busy: boolean;
    engagement?: { kind: 'chat'; with: (AgentId | 'visitor')[] };
  };

  // --- world-level state (snapshot + world.time) ---------------------------
  // phase drives the day/night tint; `awake` false => sleeping/dream mode.
  'world-state': { phase: DayPhase; visitorsPresent: number; awake: boolean };
  // Degraded-mode flag the UI can read: true when the server is unreachable or
  // budget-exhausted and the town is running on the free scripted dream layer.
  'world-sleeping': { sleeping: boolean; reason: 'budget' | 'server-down' | null };

  // --- visitor-facing chat lifecycle (WorldClient ↔ React panel) -----------
  // WorldClient opened a session (POST /chats resolved). Canvas-only hook: the
  // agent's sprite faces the player while it lasts.
  'chat-opened': { npcId: ThomasId };
  // The overlay closed the panel (visitor-initiated); WorldClient tears down.
  'chat-closed': { npcId: ThomasId };

  // --- streamed chat output (WorldClient → React panel) --------------------
  // A new speaker turn began (multi-party attribution).
  'chat-turn-started': { npcId: ThomasId; sessionId: string };
  // An incremental text delta for the current speaker's turn.
  'chat-delta': { npcId: ThomasId; sessionId: string; text: string };
  // A speaker's turn completed (text final, persisted under messageId).
  'chat-turn-done': { npcId: ThomasId; sessionId: string; messageId: string };
  // A whole assistant message (kept for back-compat with the React panel which
  // appends ChatMessage objects); WorldClient emits this on turn completion.
  'npc-chat-response': ChatMessage;
  // Restrained "drew on a memory" marker for the current turn.
  'chat-memory-recalled': { npcId: ThomasId; sessionId: string; label: string };
  // The agent acted mid-chat (a tool the agent ran while talking — "walks to
  // the workbench"). Rendered as a centered diegetic line in the transcript.
  'chat-action': { npcId: ThomasId; sessionId: string; tool: string; detail: string };
  // The agent shared a concrete card mid-chat (artifact / reference / proof).
  'chat-share-card': { npcId: ThomasId; sessionId: string; card: ShareCard };
  // The agent ended the chat itself (server already closed the session). The
  // panel shows a goodbye line + [wave goodbye] close button. `reason` is the
  // agent's optional rendering of why it wrapped up.
  'chat-ended': { npcId: ThomasId; sessionId: string; reason?: string | null };
  // A share card / chronicle citation's internal action — open the matching
  // overlay (artifact reader, reference reader, proof). `href` is a route token
  // like "artifact:<id>" / "reference:<id>" / "proof:<id>" / "thread:<id>".
  'open-card-target': { href: string };
  // WorldClient surfaces an error / 409 the panel should render in-fiction.
  'chat-error': { npcId?: ThomasId; reason: string };
  // The chat input gained/lost focus. The player freezes movement ONLY while
  // the input is focused (a chat is open but unfocused → the visitor can walk).
  'typing-focus': { focused: boolean };

  // --- dialog reader (full-screen overlays: Chronicle hub) -----------------
  'dialog-closed': undefined;
  'dialog-opened': undefined;

  // --- show-in-town / travel (feed + roster → canvas) ----------------------
  // Resolve a location into a camera move: the active scene pans to the anchor
  // when the location is in the current scene, else it starts the door-path
  // transition to that location's scene (and centers on arrival). `anchor`
  // (when given) is the precise standing point to center on — e.g. an agent's
  // resident/guest anchor; otherwise the location's resident anchor is used.
  // The active scene owns the handler (one per scene; re-subscribed in create).
  'travel-to-location': { locationId: LocationId; anchor?: { x: number; y: number } };

  // --- minimal touch (overlay → canvas) ------------------------------------
  // A tap on the world canvas: walk the player toward a world point in a
  // straight line, stopping on collision (Phaser pointer → player target).
  'tap-move': { worldX: number; worldY: number };

  // --- director / effect protocol (WorldClient → DirectorBeat overlay) ------
  // A screen-surface beat an agent ran (contract world.beat) — a card popped on
  // the visitor's screen, an emote over a head, etc. `visitorId` is the directed
  // target (null = room-wide). The DirectorBeat overlay renders it via a beat-id
  // component catalog and drops beats directed at a different visitor.
  'director-beat': {
    beat: string;
    params: Record<string, unknown>;
    agent: AgentId | null;
    location: LocationId;
    visitorId: string | null;
    ts?: string;
  };

  // --- raw world events (WorldClient → observers) ---------------------------
  // Every live contract event, unmapped. The observe dashboard's live feed
  // listens here (the mapped npc-* events only cover canvas-relevant types).
  'world-event': WorldEvent;

  // --- visitor fixture interaction (canvas → WorldClient) ------------------
  // The visitor clicked an interactive fixture (e.g. the park payphone).
  // WorldClient POSTs /visitors/:id/interact; the world routes it to a live
  // chat session or the next tick's perception.
  'visitor-interact': { locationId: LocationId; fixture: string };
}

export type WorldEventName = keyof WorldEvents;

// Typed wrapper over Phaser's EventEmitter. `emit`/`on`/`off`/`once` are
// generic over WorldEvents so payloads are checked at every call site. The
// underlying emitter is shared, so untyped Phaser internals still work.
class TypedEventBus {
  private readonly emitter = new Events.EventEmitter();

  emit<K extends WorldEventName>(
    event: K,
    ...args: WorldEvents[K] extends undefined ? [] : [WorldEvents[K]]
  ): boolean {
    return this.emitter.emit(event, ...(args as unknown[]));
  }

  on<K extends WorldEventName>(
    event: K,
    fn: (payload: WorldEvents[K]) => void,
    context?: unknown
  ): this {
    this.emitter.on(event, fn as (...a: unknown[]) => void, context);
    return this;
  }

  once<K extends WorldEventName>(
    event: K,
    fn: (payload: WorldEvents[K]) => void,
    context?: unknown
  ): this {
    this.emitter.once(event, fn as (...a: unknown[]) => void, context);
    return this;
  }

  // Scoped off: pass the SAME handler ref (and context, if used) to remove only
  // that listener. Never wipes the whole event — that footgun is gone.
  off<K extends WorldEventName>(
    event: K,
    fn?: (payload: WorldEvents[K]) => void,
    context?: unknown,
    once?: boolean
  ): this {
    this.emitter.off(event, fn as ((...a: unknown[]) => void) | undefined, context, once);
    return this;
  }
}

// Used to emit events between components, HTML and Phaser scenes.
export const EventBus = new TypedEventBus();
