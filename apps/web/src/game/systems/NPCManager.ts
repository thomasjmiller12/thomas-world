import Phaser from 'phaser';
import type { LocationId } from '@town/contract';
import { INTERACTION_RANGE } from '@/lib/constants';
import { NPC } from '../entities/NPC';
import { NPC_CONFIGS } from '../data/npc-configs';
import { findPath } from './pathfinding';
import { EventBus, type WorldEvents } from '../EventBus';
import {
  LOCATION_ANCHORS,
  locationInScene,
  locationsForScene,
} from '../data/location-anchors';
import type { ThomasId } from '@/lib/types';

// Per-scene dynamic NPC presence (design doc §6.2). Replaces the old single
// hardcoded NPC per scene: ANY agent whose server-authoritative locationId maps
// to this scene is rendered, and the sprite reflects the agent's live state —
// arrivals walk in from the door, departures walk to the door and despawn, and
// an agent the visitor is chatting with faces the player (but can still walk
// away mid-chat — agent.moved keeps flowing for a chatting agent).
//
// Driven entirely by the typed EventBus (WorldClient / snapshot / DreamMode):
//   npc-status        → authoritative location + engagement (spawn/despawn here)
//   npc-move-to       → an agent changed location (arrival / departure animation)
//   chat-opened       → the visitor engaged this agent (face the player)
//   chat-closed/-ended → the chat ended (visitor- or agent-initiated)
//
// One manager per scene. It tracks only agents currently in THIS scene's
// locations; off-scene agents are not rendered (their life rides the roster +
// feed). Interaction targeting (nearest NPC) runs over the live `npcs` list.
export class NPCManager {
  private readonly scene: Phaser.Scene;
  private readonly sceneKey: string;
  private readonly collisionLayer: Phaser.Tilemaps.TilemapLayer | null;
  private readonly player: Phaser.GameObjects.GameObject & { x: number; y: number };

  // Rendered sprites, keyed by agent id.
  private readonly sprites = new Map<ThomasId, NPC>();
  // Sprites mid-departure: removed from `sprites` but still animating their walk
  // to the exit door before they self-destruct. Tracked separately so a re-entry
  // during that window (a 90s resync npc-status, a reconnect, or the agent
  // flip-flopping its location back) RECLAIMS the same sprite instead of
  // spawning a second one — the duplicate-sprite bug. Cleared on actual destroy.
  private readonly departing = new Map<ThomasId, NPC>();
  // Last known authoritative location per agent (across all scenes), so we can
  // decide spawn/despawn without a snapshot re-read.
  private readonly agentLocations = new Map<ThomasId, LocationId>();
  // The location each rendered sprite has been placed at — so a status refresh
  // that doesn't change location doesn't re-trigger a walk.
  private readonly placedAt = new Map<ThomasId, LocationId>();
  // Agents the manager has marked as engaged-with-visitor (face the player).
  private readonly chatting = new Set<ThomasId>();
  // Which guest-anchor slots are taken, per location, so co-located agents fan
  // out instead of stacking on one tile.
  private readonly guestSlots = new Map<LocationId, Map<ThomasId, number>>();
  // Phase C (space addressing): a specific pixel the next walk for this agent
  // should aim at (resolved from agent.moved.targetZone by mapping.ts), set by
  // onMoveTo and consumed — once — by the walk that actually moves it. Absent
  // means "no specific spot" → the existing room anchor.
  private readonly pendingTarget = new Map<ThomasId, { x: number; y: number }>();

  constructor(
    scene: Phaser.Scene,
    collisionLayer: Phaser.Tilemaps.TilemapLayer | null,
    player: Phaser.GameObjects.GameObject & { x: number; y: number }
  ) {
    this.scene = scene;
    this.sceneKey = scene.scene.key;
    this.collisionLayer = collisionLayer;
    this.player = player;
    this.wire();
  }

  // --- event wiring (scoped handler refs so destroy() removes only ours) -----

  private readonly onStatus = (s: WorldEvents['npc-status']) => {
    this.agentLocations.set(s.npcId, s.locationId);
    this.reconcile(s.npcId);
    this.applyStateFor(s.npcId);
  };

  private readonly onMoveTo = (m: WorldEvents['npc-move-to']) => {
    // An agent moved — walk its sprite even while it's chatting (a chatting
    // agent retains full agency mid-chat: it can get up and walk away).
    if (m.target) this.pendingTarget.set(m.npcId, m.target);
    const prev = this.agentLocations.get(m.npcId);
    this.agentLocations.set(m.npcId, m.to);
    if (prev === m.to) {
      // Same room, but a targeted reposition (e.g. move_to toObject/toZone
      // while already there) — reconcile() only walks on a ROOM change, so
      // drive this one directly.
      if (m.target) {
        const sprite = this.sprites.get(m.npcId);
        if (sprite) {
          this.pendingTarget.delete(m.npcId);
          this.walkSprite(sprite, m.target, () => this.applyStateFor(m.npcId));
        }
      }
      return;
    }
    this.reconcile(m.npcId);
  };

  private readonly onChatOpened = (c: WorldEvents['chat-opened']) => {
    this.chatting.add(c.npcId);
    this.applyStateFor(c.npcId);
  };

  // Both close paths (visitor-initiated chat-closed, agent-initiated chat-ended)
  // clear the chatting mark.
  private readonly onChatClosed = (c: WorldEvents['chat-closed']) => {
    this.chatting.delete(c.npcId);
    this.applyStateFor(c.npcId);
  };

  private readonly onChatEnded = (c: WorldEvents['chat-ended']) => {
    this.chatting.delete(c.npcId);
    this.applyStateFor(c.npcId);
  };

  private wire(): void {
    EventBus.on('npc-status', this.onStatus);
    EventBus.on('npc-move-to', this.onMoveTo);
    EventBus.on('chat-opened', this.onChatOpened);
    EventBus.on('chat-closed', this.onChatClosed);
    EventBus.on('chat-ended', this.onChatEnded);
  }

  private unwire(): void {
    EventBus.off('npc-status', this.onStatus);
    EventBus.off('npc-move-to', this.onMoveTo);
    EventBus.off('chat-opened', this.onChatOpened);
    EventBus.off('chat-closed', this.onChatClosed);
    EventBus.off('chat-ended', this.onChatEnded);
  }

  // --- spawn / despawn ------------------------------------------------------

  // Ensure the agent is rendered iff its location maps to this scene. Arrivals
  // walk in from the door; departures walk to the door and despawn.
  private reconcile(id: ThomasId): void {
    const location = this.agentLocations.get(id);
    const here = location != null && locationInScene(location, this.sceneKey);
    const sprite = this.sprites.get(id);

    if (here && !sprite && location) {
      // Re-entry while the agent's prior sprite is still walking out the door:
      // reclaim that sprite (cancel its departure, walk it back to the anchor)
      // rather than spawn a second one stacked on top of it.
      const leaving = this.departing.get(id);
      if (leaving) {
        this.departing.delete(id);
        this.sprites.set(id, leaving);
        this.placedAt.set(id, location);
        const target = this.targetFor(id, location);
        this.walkSprite(leaving, target, () => this.applyStateFor(id));
        return;
      }
      this.spawn(id, location, /* walkIn */ true);
      this.placedAt.set(id, location);
    } else if (!here && sprite) {
      // Capture the location the sprite was actually placed at BEFORE clearing
      // it, so despawn can exit via that location's door (a park agent leaves
      // by the park door, a town agent by the town door) rather than always the
      // scene's first location.
      const exitLoc = this.placedAt.get(id) ?? null;
      this.despawn(id, exitLoc);
      this.placedAt.delete(id);
    } else if (here && sprite && location && this.placedAt.get(id) !== location) {
      // Already in this scene but its sub-location changed (town↔park): glide
      // over. Skipped when location is unchanged so a status refresh is a no-op.
      this.placedAt.set(id, location);
      const target = this.targetFor(id, location);
      this.walkSprite(sprite, target, () => this.applyStateFor(id));
    }
  }

  // Route a directed walk through A* over the collision grid (real routes
  // around walls/props); falls back to the straight-line walk — where the NPC's
  // stall guard still applies — when no path exists.
  private walkSprite(npc: NPC, target: { x: number; y: number }, done?: () => void): void {
    const path = findPath(this.collisionLayer, { x: npc.x, y: npc.y }, target);
    if (path) npc.walkPath(path, done);
    else npc.walkTo(target, done);
  }

  private spawn(id: ThomasId, location: LocationId, walkIn: boolean): void {
    const config = NPC_CONFIGS[id];
    if (!config) return;
    // Defense in depth: never leave a second sprite for this id alive. A reclaim
    // in reconcile() handles the common case; this catches any other path that
    // reaches spawn while a sprite (live or departing) still exists.
    const stale = this.sprites.get(id) ?? this.departing.get(id);
    if (stale) {
      this.sprites.delete(id);
      this.departing.delete(id);
      stale.destroy();
    }
    const target = this.targetFor(id, location);
    const door = LOCATION_ANCHORS[location].door;

    const npc = new NPC(this.scene, {
      ...config,
      // Spawn at the door so the arrival reads as walking in.
      homePosition: walkIn ? { x: door.x, y: door.y } : target,
    });
    if (this.collisionLayer) this.scene.physics.add.collider(npc, this.collisionLayer);
    this.scene.physics.add.collider(this.player, npc);
    // Wander reuses the SAME A* router as directed walks (the manager owns the
    // collision layer), so idle roams route around props/walls.
    npc.setRouter((from, to) => findPath(this.collisionLayer, from, to));
    this.sprites.set(id, npc);

    if (walkIn) {
      this.walkSprite(npc, target, () => this.applyStateFor(id));
    } else {
      this.applyStateFor(id);
    }
  }

  private despawn(id: ThomasId, exitLoc: LocationId | null = null): void {
    const sprite = this.sprites.get(id);
    if (!sprite) return;
    // Free its guest slot regardless of which scene it's leaving.
    this.releaseGuestSlot(id);
    this.sprites.delete(id);
    // Park it as departing so a re-entry mid-exit reclaims it (see reconcile)
    // instead of spawning a duplicate.
    this.departing.set(id, sprite);

    const finish = () => {
      // Only destroy if this sprite is STILL the departing one — a reclaim moved
      // it back into `sprites` and re-tasked its walk, so its old exit callback
      // firing must not destroy the now-live sprite.
      if (this.departing.get(id) !== sprite) return;
      this.departing.delete(id);
      sprite.destroy();
    };
    // Exit via the door of the location the sprite was actually placed at (a
    // park agent leaves by the park door, a town agent by the town door); fall
    // back to the scene's first-location door when the prior location is unknown.
    const exitDoor =
      (exitLoc ? LOCATION_ANCHORS[exitLoc]?.door : null) ?? this.doorForCurrentScene();
    if (exitDoor) this.walkSprite(sprite, exitDoor, finish);
    else finish();
  }

  // --- per-agent sprite state ----------------------------------------------

  // Choose the right NPC sub-state from the manager's bookkeeping.
  private applyStateFor(id: ThomasId): void {
    const sprite = this.sprites.get(id);
    if (!sprite) return;
    // Don't interrupt an in-flight directed walk (arrival/departure).
    if (sprite.getState() === 'walking') return;

    if (this.chatting.has(id)) {
      sprite.enterEngaged(this.player.x, this.player.y);
      return;
    }

    const location = this.agentLocations.get(id);
    const home = location ? this.anchorFor(id, location) : undefined;
    sprite.enterWander(home);
  }

  // --- anchor / slot bookkeeping --------------------------------------------

  // The walk target for an agent arriving/repositioning at a location: a
  // pending Phase-C target if one was just set (consumed once), else the
  // ordinary room anchor.
  private targetFor(id: ThomasId, location: LocationId): { x: number; y: number } {
    const pending = this.pendingTarget.get(id);
    if (pending) {
      this.pendingTarget.delete(id);
      return pending;
    }
    return this.anchorFor(id, location);
  }

  // The standing point for an agent at a location: its own resident anchor if
  // it lives there, else a stable guest slot.
  private anchorFor(id: ThomasId, location: LocationId): { x: number; y: number } {
    const anchors = LOCATION_ANCHORS[location];
    const config = NPC_CONFIGS[id];
    const isResident =
      config?.homeBuilding === location ||
      (location === 'town' && config?.homeBuilding === 'park') ||
      (location === 'park' && config?.homeBuilding === 'park');
    if (isResident) return anchors.resident;
    return anchors.guests[this.guestSlot(location, id)] ?? anchors.resident;
  }

  // Assign a stable guest-slot index for (location, agent).
  private guestSlot(location: LocationId, id: ThomasId): number {
    let slots = this.guestSlots.get(location);
    if (!slots) {
      slots = new Map();
      this.guestSlots.set(location, slots);
    }
    const existing = slots.get(id);
    if (existing != null) return existing;
    const taken = new Set(slots.values());
    let idx = 0;
    while (taken.has(idx)) idx++;
    slots.set(id, idx);
    return idx;
  }

  private releaseGuestSlot(id: ThomasId): void {
    for (const slots of this.guestSlots.values()) slots.delete(id);
  }

  private doorForCurrentScene(): { x: number; y: number } | null {
    const locs = locationsForScene(this.sceneKey);
    const first = locs[0];
    return first ? LOCATION_ANCHORS[first].door : null;
  }

  // --- per-frame (called from the scene's update) ---------------------------

  // Update every sprite, run proximity checks, and return the nearest agent the
  // player can interact with (replaces the hardcoded single-NPC targeting).
  update(): NPC | null {
    // Departing sprites still need per-frame ticks to animate their walk to the
    // door and fire the arrival callback that destroys them; they are NOT
    // interaction targets (they're on their way out of the scene).
    for (const npc of this.departing.values()) npc.update();

    let nearest: NPC | null = null;
    let nearestDist = Infinity;
    for (const npc of this.sprites.values()) {
      npc.update();
      npc.checkProximity(this.player.x, this.player.y);
      // Every rendered agent is a chat target — even a WALKING one (pressing
      // talk reaches them — "hey, got a sec?"). Excluding states here once made
      // agents unchattable when a bad anchor left a sprite stuck mid-walk.
      const dist = Phaser.Math.Distance.Between(
        this.player.x, this.player.y, npc.x, npc.y
      );
      if (dist <= INTERACTION_RANGE && dist < nearestDist) {
        nearestDist = dist;
        nearest = npc;
      }
    }
    return nearest;
  }

  // Look up a live sprite (for facing-the-player when the visitor interacts).
  get(id: ThomasId): NPC | undefined {
    return this.sprites.get(id);
  }

  // The NPC at/near a world point — for tap-an-agent (minimal touch). Returns
  // the nearest rendered, non-walking agent within `radius` px, else null.
  npcAt(worldX: number, worldY: number, radius = 14): NPC | null {
    let nearest: NPC | null = null;
    let nearestDist = radius;
    for (const npc of this.sprites.values()) {
      const dist = Phaser.Math.Distance.Between(worldX, worldY, npc.x, npc.y);
      if (dist <= nearestDist) {
        nearestDist = dist;
        nearest = npc;
      }
    }
    return nearest;
  }

  destroy(): void {
    this.unwire();
    for (const npc of this.sprites.values()) npc.destroy();
    for (const npc of this.departing.values()) npc.destroy();
    this.departing.clear();
    this.sprites.clear();
    this.guestSlots.clear();
    this.chatting.clear();
    this.placedAt.clear();
    this.agentLocations.clear();
  }
}
