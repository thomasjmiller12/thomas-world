import Phaser from 'phaser';
import { CAMERA_ZOOM, SCENE_KEYS } from '@/lib/constants';
import { Player } from '../entities/Player';
import { NPC } from '../entities/NPC';
import { NPCManager } from '../systems/NPCManager';
import { EventBus } from '../EventBus';
import { getDoorByScene, type DoorConfig } from '../data/door-configs';
import { locationForScene, locationInScene, LOCATION_ANCHORS } from '../data/location-anchors';
import { resolveTravel } from '../data/travel';
import type { LocationId } from '@town/contract';

const EXIT_INTERACTION_RANGE = 20;

export interface InteriorState {
  player: Player;
  // Server-authoritative dynamic NPC presence (design §6.2) — replaces the old
  // single resident `npc`. Any agent whose live location maps to this interior
  // is rendered + animated by the manager.
  npcManager: NPCManager;
  nearestNPC: NPC | null;
  returnX: number;
  returnY: number;
  isExiting: boolean;
  exitPrompt: Phaser.GameObjects.Graphics | null;
  door: DoorConfig;
  // Scoped player-interact handler ref — removed (only it) on exit so we never
  // wipe other scenes' listeners with a bare removeAllListeners.
  onPlayerInteract?: () => void;
  // Scoped show-in-town handler ref (removed on exit).
  onTravel?: (p: { locationId: LocationId; anchor?: { x: number; y: number } }) => void;
}

export function initInterior(
  scene: Phaser.Scene,
  data: { returnX?: number; returnY?: number; visitorName?: string },
  state: InteriorState
) {
  const door = getDoorByScene(scene.scene.key);
  if (!door) throw new Error(`No door config for scene ${scene.scene.key}`);
  state.door = door;
  state.returnX = data.returnX ?? door.returnX;
  state.returnY = data.returnY ?? door.returnY;
  if (data.visitorName) scene.registry.set('visitorName', data.visitorName);
  state.isExiting = false;
  state.exitPrompt = null;
}

export function setupInterior(
  scene: Phaser.Scene,
  tilemap: Phaser.Tilemaps.Tilemap,
  // Kept for call-site clarity (which facet "owns" this room) but presence is
  // now fully server-authoritative via the NPCManager — the resident is spawned
  // by its live location like any other agent, not hardcoded here.
  _residentId: string,
  _residentSpawn: { x: number; y: number },
  locationName: string,
  state: InteriorState
) {
  const door = state.door;

  scene.cameras.main.fadeIn(300, 0, 0, 0);

  // Collision layer
  const collisionLayer = tilemap.getLayer('collisions')?.tilemapLayer;
  if (collisionLayer) {
    collisionLayer.setCollisionByExclusion([-1, 0]);
    collisionLayer.setVisible(false);
  }

  // Hide spawns
  const spawnsLayer = tilemap.getLayer('spawns')?.tilemapLayer;
  if (spawnsLayer) spawnsLayer.setVisible(false);

  // Depth sorting (above player depth of 16)
  const furnitureTopsLayer = tilemap.getLayer('furnitureTops')?.tilemapLayer;
  if (furnitureTopsLayer) furnitureTopsLayer.setDepth(50);

  // Player
  state.player = new Player(scene, door.interior.spawnX, door.interior.spawnY);
  state.player.visitorName = scene.registry.get('visitorName') || 'Visitor';
  if (collisionLayer) scene.physics.add.collider(state.player, collisionLayer);

  // Dynamic NPC presence — manager renders/animates every agent whose live
  // location maps to this interior (resident + any visiting agents).
  state.npcManager = new NPCManager(scene, collisionLayer ?? null, state.player);
  state.nearestNPC = null;

  // Camera
  scene.cameras.main.setRoundPixels(true);
  scene.cameras.main.startFollow(state.player, true, 0.1, 0.1);
  scene.cameras.main.setZoom(CAMERA_ZOOM);
  scene.cameras.main.setBounds(0, 0, tilemap.widthInPixels, tilemap.heightInPixels);
  scene.physics.world.setBounds(0, 0, tilemap.widthInPixels, tilemap.heightInPixels);

  // Exit door prompt arrow
  const g = scene.add.graphics();
  g.setPosition(door.interior.exitX, door.interior.exitY - 14);
  g.setDepth(21);
  g.setVisible(false);
  g.fillStyle(0xffffff, 0.8);
  g.fillTriangle(-4, -3, 4, -3, 0, 3);
  g.fillCircle(0, 5, 1);
  state.exitPrompt = g;

  // Interaction handler — kept as a ref so we can scope-remove it on exit.
  state.onPlayerInteract = () => {
    if (state.isExiting) return;

    // NPC interaction takes priority — nearest agent from the dynamic list.
    if (state.nearestNPC) {
      state.nearestNPC.enterEngaged(state.player.x, state.player.y);
      EventBus.emit('npc-interaction', {
        npcId: state.nearestNPC.npcId,
        npcName: state.nearestNPC.displayName,
      });
      EventBus.emit('chat-opened', { npcId: state.nearestNPC.npcId });
      return;
    }

    // Exit door interaction
    const dist = Phaser.Math.Distance.Between(
      state.player.x, state.player.y,
      door.interior.exitX, door.interior.exitY
    );
    if (dist <= EXIT_INTERACTION_RANGE) {
      handleExit(scene, state);
    }
  };
  EventBus.on('player-interact', state.onPlayerInteract);

  // Show-in-town: pan when the target is THIS interior, else exit to town and
  // let the town scene resolve the rest (stashing the target as a pending hop
  // so a different building still gets reached — design §6.3).
  state.onTravel = (p) => {
    if (state.isExiting) return;
    if (locationInScene(p.locationId, scene.scene.key)) {
      const target = p.anchor ?? LOCATION_ANCHORS[p.locationId].resident;
      const cam = scene.cameras.main;
      cam.stopFollow();
      cam.pan(target.x, target.y, 450, 'Sine.easeInOut', false, (_c, progress) => {
        if (progress === 1) cam.startFollow(state.player, true, 0.1, 0.1);
      });
      return;
    }
    const plan = resolveTravel(scene.scene.key, p.locationId, p.anchor);
    if (plan.kind === 'to-town') {
      scene.registry.set('travelCenter', plan.anchor);
    } else {
      // Different interior: hop via town, then re-issue the travel from there.
      scene.registry.set('pendingTravel', { locationId: p.locationId, anchor: p.anchor });
    }
    handleExit(scene, state);
  };
  EventBus.on('travel-to-location', state.onTravel);

  // Minimal touch: tap an agent → Tier-1 dialog, else tap-to-move.
  scene.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    if (state.isExiting) return;
    const tapped = state.npcManager.npcAt(pointer.worldX, pointer.worldY);
    if (tapped) {
      tapped.enterEngaged(state.player.x, state.player.y);
      EventBus.emit('npc-interaction', { npcId: tapped.npcId, npcName: tapped.displayName });
      EventBus.emit('chat-opened', { npcId: tapped.npcId });
      return;
    }
    EventBus.emit('tap-move', { worldX: pointer.worldX, worldY: pointer.worldY });
  });

  EventBus.emit('scene-changed', {
    scene: scene.scene.key,
    locationName,
    locationId: locationForScene(scene.scene.key) ?? undefined,
  });
  EventBus.emit('current-scene-ready', scene);
}

export function updateInterior(state: InteriorState) {
  state.player.update();
  // Manager updates every NPC + returns the nearest interactable.
  state.nearestNPC = state.npcManager.update();

  // Show/hide exit prompt based on proximity
  if (state.exitPrompt && !state.isExiting) {
    const dist = Phaser.Math.Distance.Between(
      state.player.x, state.player.y,
      state.door.interior.exitX, state.door.interior.exitY
    );
    const nearExit = dist <= EXIT_INTERACTION_RANGE;
    state.exitPrompt.setVisible(nearExit && !state.nearestNPC);
  }
}

function handleExit(scene: Phaser.Scene, state: InteriorState) {
  if (state.isExiting) return;
  state.isExiting = true;
  if (state.exitPrompt) state.exitPrompt.setVisible(false);

  const cam = scene.cameras?.main;
  if (!cam) return;

  cam.fadeOut(300, 0, 0, 0);
  cam.once('camerafadeoutcomplete', () => {
    if (!scene.scene?.isActive(scene.scene.key)) return;
    if (state.onPlayerInteract) {
      EventBus.off('player-interact', state.onPlayerInteract);
      state.onPlayerInteract = undefined;
    }
    if (state.onTravel) {
      EventBus.off('travel-to-location', state.onTravel);
      state.onTravel = undefined;
    }
    scene.input.removeAllListeners('pointerdown');
    state.npcManager.destroy();
    scene.scene.start(SCENE_KEYS.TOWN, {
      spawnX: state.returnX,
      spawnY: state.returnY + 16,
      visitorName: state.player.visitorName,
    });
  });
}
