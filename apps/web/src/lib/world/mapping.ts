import type { WorldEvent, AgentStatus } from '@town/contract';
import type { WorldEventName, WorldEvents } from '@/game/EventBus';
import { pixelForZone } from '@/game/data/zone-bounds';

// Pure mapping from contract WorldEvents → the typed EventBus events the UI
// consumes (design doc §6.1). Kept pure (returns the events to emit instead of
// emitting) so the mapping is unit-testable without an EventBus or network.
//
// `agentId` on the contract envelope is the AgentId enum (a subset of ThomasId),
// so it's safe to forward directly as a ThomasId.

export interface EmitSpec<K extends WorldEventName = WorldEventName> {
  name: K;
  payload: WorldEvents[K];
}

// Helper to build a strongly-typed spec entry.
function spec<K extends WorldEventName>(name: K, payload: WorldEvents[K]): EmitSpec<K> {
  return { name, payload };
}

// Translate one contract event into zero or more EventBus emits. Events with no
// UI surface (e.g. message.sent headline, bulletin.posted) map to nothing here
// — they live in the feed, not the canvas.
export function mapWorldEvent(ev: WorldEvent): EmitSpec[] {
  switch (ev.type) {
    case 'agent.moved':
      return [
        spec('npc-move-to', {
          npcId: ev.payload.agent,
          from: ev.payload.from,
          to: ev.payload.to,
          // Phase C: the server names a zone (a word); we resolve it to a
          // pixel here so NPCManager can walk there. An unresolvable/absent
          // zone leaves `target` undefined — the manager falls back to the
          // room anchor, never an error.
          target: ev.payload.targetZone ? pixelForZone(ev.payload.targetZone) : undefined,
        }),
      ];

    case 'agent.thought':
      return [spec('npc-thought', { npcId: ev.payload.agent, thought: ev.payload.text, ts: ev.ts })];

    case 'agent.spoke':
      return [
        spec('npc-speech', {
          npcId: ev.payload.agent,
          message: ev.payload.text,
          audience: 'public',
          location: ev.payload.location,
          ts: ev.ts,
          id: ev.id,
        }),
      ];

    case 'agent.activity':
      return [spec('npc-activity', { npcId: ev.payload.agent, activity: ev.payload.activity })];

    case 'world.effect':
      return [
        spec('fixture-effect', {
          location: ev.payload.location,
          fixture: ev.payload.fixture,
          effect: ev.payload.effect,
          npcId: ev.payload.agent,
        }),
      ];

    // A screen-surface director beat (contract world.beat) — a card/emote that
    // crosses the glass onto the visitor's client. Object-surface beats arrive
    // via the dual-emitted world.effect → fixture-effect path (sprite FX), so
    // those don't come through here; this case carries only the screen layer.
    // `visitorId` is the directed target (null = room-wide); the overlay does
    // the per-visitor filtering, not this pure mapping.
    case 'world.beat':
      return [
        spec('director-beat', {
          beat: ev.payload.beat,
          params: ev.payload.params,
          agent: ev.payload.agent,
          location: ev.payload.location,
          visitorId: ev.payload.visitorId,
          ts: ev.ts,
        }),
      ];

    case 'world.time':
      // Phase change updates only the tint; visitor count / awake come from the
      // snapshot's world block (and stay until the next snapshot). We surface
      // phase via world-state with conservative defaults the caller overrides.
      return [
        spec('world-state', {
          phase: ev.payload.phase,
          visitorsPresent: 0,
          awake: true,
        }),
      ];

    // Surfaced via feed / roster only — no canvas emit:
    case 'message.sent':
    case 'artifact.created':
    case 'artifact.updated':
    case 'bulletin.posted':
    case 'capability.requested':
    case 'visitor.arrived':
    case 'visitor.left':
    case 'visitor.moved':
    case 'visitor.interacted':
      return [];

    case 'visitor.escorted':
      return [
        spec('visitor-escort', {
          visitorId: ev.payload.visitorId,
          agent: ev.payload.agent,
          from: ev.payload.from,
          to: ev.payload.to,
          targetZone: ev.payload.targetZone ?? null,
        }),
      ];

    case 'chat.started':
    case 'chat.ended':
    // Paced scenes were removed in M2.1 — these types are no longer emitted but
    // are kept in the contract so historical world_events rows still parse on
    // SSE resume / feed reads. They have no canvas surface now.
    case 'conversation.started':
    case 'conversation.turn':
    case 'conversation.ended':
    case 'conversation.converted':
    case 'chat.joined':
    // Canonical object-graph + artifact-state events. These have canvas/panel
    // surfaces, but their consumers (PlacedObjects, ArtifactFrame) subscribe to
    // the raw 'world-event' channel directly — no mapped npc-* emit needed.
    case 'object.created':
    case 'object.removed':
    case 'object.moved':
    case 'object.state_changed':
    case 'object.attached':
    case 'object.noted':
    case 'artifact.state_changed':
      return [];

    default: {
      // Exhaustiveness guard: a new contract event type forces a compile error.
      const _never: never = ev;
      void _never;
      return [];
    }
  }
}

// Snapshot hydration → per-agent status emits (positions/status, design doc
// §6.1). One npc-status per agent.
export function mapAgentStatus(agent: AgentStatus): EmitSpec<'npc-status'> {
  return spec('npc-status', {
    npcId: agent.id,
    locationId: agent.locationId,
    status: agent.status,
    activity: agent.activity,
  });
}

// Resolve the world-server base URL from the build-time env var, falling back
// to the dev port the world server actually listens on (8787, per apps/world
// README). Trailing slash trimmed so callers can append paths cleanly.
export function resolveWorldBaseUrl(envUrl: string | undefined): string {
  const url = (envUrl && envUrl.trim()) || 'http://localhost:8787';
  return url.replace(/\/+$/, '');
}

// Exponential backoff with jitter for SSE reconnects. Caps at 30s.
export function reconnectDelayMs(attempt: number): number {
  const base = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
  const jitter = Math.random() * 0.3 * base;
  return Math.round(base + jitter);
}
