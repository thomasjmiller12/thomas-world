import Phaser from 'phaser';
import { CAMERA_ZOOM, INTERACTION_RANGE, SCENE_KEYS } from '@/lib/constants';
import { Player } from '../entities/Player';
import { NPC } from '../entities/NPC';
import { NPC_CONFIGS } from '../data/npc-configs';
import { EventBus } from '../EventBus';
import { getDoorByScene, type DoorConfig } from '../data/door-configs';
import type { ThomasId } from '@/lib/types';

const EXIT_INTERACTION_RANGE = 20;

export interface InteriorState {
  player: Player;
  npc: NPC;
  returnX: number;
  returnY: number;
  isExiting: boolean;
  exitPrompt: Phaser.GameObjects.Graphics | null;
  door: DoorConfig;
  // Scoped player-interact handler ref — removed (only it) on exit so we never
  // wipe other scenes' listeners with a bare removeAllListeners.
  onPlayerInteract?: () => void;
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
  npcId: string,
  npcSpawn: { x: number; y: number },
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

  // NPC
  const npcConfig = NPC_CONFIGS[npcId];
  state.npc = new NPC(scene, {
    ...npcConfig,
    homePosition: npcSpawn,
    waypoints: [npcSpawn, { x: npcSpawn.x + 40, y: npcSpawn.y }],
  });
  if (collisionLayer) scene.physics.add.collider(state.npc, collisionLayer);
  scene.physics.add.collider(state.player, state.npc);

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

    // NPC interaction takes priority
    if (state.npc.isPlayerInRange(state.player.x, state.player.y)) {
      state.npc.facePlayer(state.player.x, state.player.y);
      EventBus.emit('npc-interaction', {
        npcId: npcId as ThomasId,
        npcName: npcConfig.displayName,
      });
      EventBus.emit('chat-opened', { npcId: npcId as ThomasId });
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

  EventBus.emit('scene-changed', { scene: scene.scene.key, locationName });
  EventBus.emit('current-scene-ready', scene);
}

export function updateInterior(state: InteriorState) {
  state.player.update();
  state.npc.update();
  state.npc.checkProximity(state.player.x, state.player.y);

  // Show/hide exit prompt based on proximity
  if (state.exitPrompt && !state.isExiting) {
    const dist = Phaser.Math.Distance.Between(
      state.player.x, state.player.y,
      state.door.interior.exitX, state.door.interior.exitY
    );
    const nearExit = dist <= EXIT_INTERACTION_RANGE;
    const npcInRange = state.npc.isPlayerInRange(state.player.x, state.player.y);
    state.exitPrompt.setVisible(nearExit && !npcInRange);
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
    scene.scene.start(SCENE_KEYS.TOWN, {
      spawnX: state.returnX,
      spawnY: state.returnY + 16,
      visitorName: state.player.visitorName,
    });
  });
}
