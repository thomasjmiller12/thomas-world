import { Events } from 'phaser';
import type { AgentId, DayPhase, LocationId } from '@town/contract';
import type { ThomasId, ChatMessage, DialogData } from '@/lib/types';

// The typed event taxonomy that flows over the EventBus — the seam between the
// world (WorldClient / dream mode) and the surfaces (Phaser canvas + React
// overlay). Names map near-1:1 to contract world events (design doc §6.1):
//   agent.moved      → npc-move-to
//   agent.thought    → npc-thought
//   agent.spoke      → npc-speech            (ambient/overheard)
//   conversation.turn→ npc-speech (scene)    (alternating bubble dialogue)
//   agent.activity   → npc-activity
//   world.effect     → fixture-effect
//   chat.joined etc. → chat-*
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
  // A public-safe thought wisp (contract agent.thought).
  'npc-thought': { npcId: ThomasId; thought: string };
  // Overheard ambient speech / a scene turn (contract agent.spoke + conversation.turn).
  // `conversationId` present marks it as part of a live agent↔agent scene.
  // `location` is present for ambient speech (used for bubble scoping); scene
  // turns carry no location on the wire — scope them via the scene's location.
  'npc-speech': { npcId: ThomasId; message: string; audience: string; conversationId?: string; location?: LocationId };
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
    engagement?: { kind: 'chat' | 'scene'; with: (AgentId | 'visitor')[] };
  };

  // --- world-level state (snapshot + world.time) ---------------------------
  // phase drives the day/night tint; `awake` false => sleeping/dream mode.
  'world-state': { phase: DayPhase; visitorsPresent: number; awake: boolean };
  // Degraded-mode flag the UI can read: true when the server is unreachable or
  // budget-exhausted and the town is running on the free scripted dream layer.
  'world-sleeping': { sleeping: boolean; reason: 'budget' | 'server-down' | null };

  // --- live agent↔agent scenes (Tier 0 listen-in surface) ------------------
  'scene-started': { conversationId: string; location: LocationId; participants: ThomasId[] };
  'scene-ended': { conversationId: string };
  // A paced scene converted to a group chat (visitor interjected).
  'scene-converted': { conversationId: string };

  // --- visitor-facing chat lifecycle (WorldClient ↔ React panel) -----------
  // The overlay asks WorldClient to open a chat with an agent (Tier-1 escalate).
  'chat-open-request': { npcId: ThomasId };
  // The overlay sends a visitor line; WorldClient streams the reply.
  'chat-message-sent': { npcId: ThomasId; message: string };
  // The overlay closed the panel; WorldClient tears the session down.
  'chat-closed': { npcId: ThomasId };
  // Canvas-only hooks (pause player input / NPC roaming while chatting).
  'chat-opened': { npcId: ThomasId };

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
  // Post-turn reply chips (off the latency path).
  'chat-suggested-replies': { sessionId: string; replies: string[] };
  // A second agent joined the session (invite_to_chat / scene conversion).
  'chat-joined': { sessionId?: string; npcId: ThomasId };
  // WorldClient surfaces an error / 409 the panel should render in-fiction.
  'chat-error': { npcId?: ThomasId; reason: string };

  // --- dialog reader (artifact/show-dialog) --------------------------------
  'show-dialog': DialogData;
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
