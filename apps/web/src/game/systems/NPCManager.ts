import Phaser from 'phaser';
import type { LocationId } from '@town/contract';
import { INTERACTION_RANGE } from '@/lib/constants';
import { NPC } from '../entities/NPC';
import { NPC_CONFIGS } from '../data/npc-configs';
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
// arrivals walk in from the door, departures walk to the door and despawn,
// agents in a live scene face each other, and an agent the visitor is chatting
// with faces the player.
//
// Driven entirely by the typed EventBus (WorldClient / snapshot / DreamMode):
//   npc-status        → authoritative location + engagement (spawn/despawn here)
//   npc-move-to       → an agent changed location (arrival / departure animation)
//   scene-started/-ended/-converted → live agent↔agent scene framing (in-scene state)
//   npc-speech        → drive the "next speaker thinks" bubble between turns
//   chat-opened/-closed → the visitor engaged this agent (face the player)
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
  // Last known authoritative location per agent (across all scenes), so we can
  // decide spawn/despawn without a snapshot re-read.
  private readonly agentLocations = new Map<ThomasId, LocationId>();
  // The location each rendered sprite has been placed at — so a status refresh
  // that doesn't change location doesn't re-trigger a walk.
  private readonly placedAt = new Map<ThomasId, LocationId>();
  // Agents the manager has marked as engaged-with-visitor (face the player).
  private readonly chatting = new Set<ThomasId>();
  // conversationId → participants, for the in-scene facing + thinking cues.
  private readonly scenes = new Map<string, ThomasId[]>();
  // Which guest-anchor slots are taken, per location, so co-located agents fan
  // out instead of stacking on one tile.
  private readonly guestSlots = new Map<LocationId, Map<ThomasId, number>>();

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
    // engagement.kind === 'chat' with 'visitor' means this agent is in a chat
    // with the visitor; face the player while it lasts.
    const withVisitor =
      s.engagement?.kind === 'chat' && s.engagement.with.includes('visitor');
    if (withVisitor) this.chatting.add(s.npcId);
    else this.chatting.delete(s.npcId);
    this.applyStateFor(s.npcId);
  };

  private readonly onMoveTo = (m: WorldEvents['npc-move-to']) => {
    const prev = this.agentLocations.get(m.npcId);
    this.agentLocations.set(m.npcId, m.to);
    if (prev === m.to) return;
    this.reconcile(m.npcId);
  };

  private readonly onSceneStarted = (e: WorldEvents['scene-started']) => {
    this.scenes.set(e.conversationId, e.participants);
    for (const id of e.participants) this.applyStateFor(id);
  };

  private readonly onSceneEnded = (e: WorldEvents['scene-ended']) => {
    const participants = this.scenes.get(e.conversationId) ?? [];
    this.scenes.delete(e.conversationId);
    for (const id of participants) {
      this.sprites.get(id)?.setThinking(false);
      this.applyStateFor(id);
    }
  };

  private readonly onSceneConverted = (e: WorldEvents['scene-converted']) => {
    // Converted → group chat; the scene framing is over for canvas purposes.
    this.onSceneEnded({ conversationId: e.conversationId });
  };

  // A scene turn arrived: clear everyone's thinking bubble, then the NEXT
  // speaker (the *other* participant) shows the "…" between turns.
  private readonly onSpeech = (s: WorldEvents['npc-speech']) => {
    if (!s.conversationId) return;
    const participants = this.scenes.get(s.conversationId);
    if (!participants) return;
    for (const id of participants) this.sprites.get(id)?.setThinking(false);
    const next = participants.find((id) => id !== s.npcId);
    if (next) this.sprites.get(next)?.setThinking(true);
  };

  private readonly onChatOpened = (c: WorldEvents['chat-opened']) => {
    this.chatting.add(c.npcId);
    this.applyStateFor(c.npcId);
  };

  private readonly onChatClosed = (c: WorldEvents['chat-closed']) => {
    this.chatting.delete(c.npcId);
    this.applyStateFor(c.npcId);
  };

  private wire(): void {
    EventBus.on('npc-status', this.onStatus);
    EventBus.on('npc-move-to', this.onMoveTo);
    EventBus.on('scene-started', this.onSceneStarted);
    EventBus.on('scene-ended', this.onSceneEnded);
    EventBus.on('scene-converted', this.onSceneConverted);
    EventBus.on('npc-speech', this.onSpeech);
    EventBus.on('chat-opened', this.onChatOpened);
    EventBus.on('chat-closed', this.onChatClosed);
  }

  private unwire(): void {
    EventBus.off('npc-status', this.onStatus);
    EventBus.off('npc-move-to', this.onMoveTo);
    EventBus.off('scene-started', this.onSceneStarted);
    EventBus.off('scene-ended', this.onSceneEnded);
    EventBus.off('scene-converted', this.onSceneConverted);
    EventBus.off('npc-speech', this.onSpeech);
    EventBus.off('chat-opened', this.onChatOpened);
    EventBus.off('chat-closed', this.onChatClosed);
  }

  // --- spawn / despawn ------------------------------------------------------

  // Ensure the agent is rendered iff its location maps to this scene. Arrivals
  // walk in from the door; departures walk to the door and despawn.
  private reconcile(id: ThomasId): void {
    const location = this.agentLocations.get(id);
    const here = location != null && locationInScene(location, this.sceneKey);
    const sprite = this.sprites.get(id);

    if (here && !sprite && location) {
      this.spawn(id, location, /* walkIn */ true);
      this.placedAt.set(id, location);
    } else if (!here && sprite) {
      this.despawn(id);
      this.placedAt.delete(id);
    } else if (here && sprite && location && this.placedAt.get(id) !== location) {
      // Already in this scene but its sub-location changed (town↔park): glide
      // over. Skipped when location is unchanged so a status refresh is a no-op.
      this.placedAt.set(id, location);
      const anchor = this.anchorFor(id, location);
      sprite.walkTo(anchor, () => this.applyStateFor(id));
    }
  }

  private spawn(id: ThomasId, location: LocationId, walkIn: boolean): void {
    const config = NPC_CONFIGS[id];
    if (!config) return;
    const target = this.anchorFor(id, location);
    const door = LOCATION_ANCHORS[location].door;

    const npc = new NPC(this.scene, {
      ...config,
      // Spawn at the door so the arrival reads as walking in.
      homePosition: walkIn ? { x: door.x, y: door.y } : target,
    });
    if (this.collisionLayer) this.scene.physics.add.collider(npc, this.collisionLayer);
    this.scene.physics.add.collider(this.player, npc);
    this.sprites.set(id, npc);

    if (walkIn) {
      npc.walkTo(target, () => this.applyStateFor(id));
    } else {
      this.applyStateFor(id);
    }
  }

  private despawn(id: ThomasId): void {
    const sprite = this.sprites.get(id);
    if (!sprite) return;
    const location = this.agentLocations.get(id);
    const door = location ? LOCATION_ANCHORS[location]?.door : null;
    // Free its guest slot regardless of which scene it's leaving.
    this.releaseGuestSlot(id);
    this.sprites.delete(id);

    const finish = () => {
      sprite.destroy();
    };
    // Walk to the door of whichever scene-location it was just in, then despawn.
    const exitDoor = this.doorForCurrentScene() ?? door;
    if (exitDoor) sprite.walkTo(exitDoor, finish);
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

    const sceneId = this.sceneFor(id);
    if (sceneId) {
      const partner = this.partnerSprite(sceneId, id);
      sprite.enterScene(partner ? { x: partner.x, y: partner.y } : undefined);
      return;
    }

    const location = this.agentLocations.get(id);
    const home = location ? this.anchorFor(id, location) : undefined;
    sprite.enterWander(home);
  }

  private sceneFor(id: ThomasId): string | null {
    for (const [convId, participants] of this.scenes) {
      if (participants.includes(id)) return convId;
    }
    return null;
  }

  private partnerSprite(conversationId: string, id: ThomasId): NPC | null {
    const participants = this.scenes.get(conversationId) ?? [];
    const partnerId = participants.find((p) => p !== id);
    return partnerId ? this.sprites.get(partnerId) ?? null : null;
  }

  // --- anchor / slot bookkeeping --------------------------------------------

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
    let nearest: NPC | null = null;
    let nearestDist = Infinity;
    for (const npc of this.sprites.values()) {
      npc.update();
      npc.checkProximity(this.player.x, this.player.y);
      // An agent locked in a live scene or mid-walk isn't a chat target.
      if (npc.getState() === 'walking') continue;
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

  destroy(): void {
    this.unwire();
    for (const npc of this.sprites.values()) npc.destroy();
    this.sprites.clear();
    this.scenes.clear();
    this.guestSlots.clear();
    this.chatting.clear();
    this.placedAt.clear();
    this.agentLocations.clear();
  }
}
