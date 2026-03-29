import Phaser from 'phaser';
import { CAMERA_ZOOM, INTERACTION_RANGE, SCENE_KEYS } from '@/lib/constants';
import { Player } from '../entities/Player';
import { NPC } from '../entities/NPC';
import { NPC_CONFIGS } from '../data/npc-configs';
import { EventBus } from '../EventBus';
import { getDoorByScene, type DoorConfig } from '../data/door-configs';

export interface InteriorState {
  player: Player;
  npc: NPC;
  returnX: number;
  returnY: number;
  isExiting: boolean;
}

export function initInterior(
  scene: Phaser.Scene,
  data: { returnX?: number; returnY?: number; visitorName?: string },
  state: InteriorState
) {
  const door = getDoorByScene(scene.scene.key);
  if (!door) throw new Error(`No door config for scene ${scene.scene.key}`);
  state.returnX = data.returnX ?? door.returnX;
  state.returnY = data.returnY ?? door.returnY;
  if (data.visitorName) scene.registry.set('visitorName', data.visitorName);
  state.isExiting = false;
}

export function setupInterior(
  scene: Phaser.Scene,
  tilemap: Phaser.Tilemaps.Tilemap,
  npcId: string,
  npcSpawn: { x: number; y: number },
  locationName: string,
  state: InteriorState
) {
  const door = getDoorByScene(scene.scene.key)!;

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

  // Depth sorting
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

  // Exit zone
  const exitZone = scene.add.zone(
    door.interior.exitX,
    door.interior.exitY,
    door.interior.exitWidth,
    door.interior.exitHeight
  );
  scene.physics.add.existing(exitZone, true);
  (exitZone.body as Phaser.Physics.Arcade.StaticBody).setSize(
    door.interior.exitWidth,
    door.interior.exitHeight
  );
  scene.physics.add.overlap(state.player, exitZone, () => {
    handleExit(scene, state);
  });

  // NPC interaction
  EventBus.on('player-interact', () => {
    if (state.npc.isPlayerInRange(state.player.x, state.player.y)) {
      state.npc.facePlayer(state.player.x, state.player.y);
      EventBus.emit('npc-interaction', {
        npcId: npcId,
        npcName: npcConfig.displayName,
      });
      EventBus.emit('chat-opened', { npcId: npcId });
    }
  });

  EventBus.emit('scene-changed', { scene: scene.scene.key, locationName });
  EventBus.emit('current-scene-ready', scene);
}

export function updateInterior(state: InteriorState) {
  state.player.update();
  state.npc.update();
  state.npc.checkProximity(state.player.x, state.player.y);
}

function handleExit(scene: Phaser.Scene, state: InteriorState) {
  if (state.isExiting) return;
  state.isExiting = true;

  const cam = scene.cameras?.main;
  if (!cam) return;

  cam.fadeOut(300, 0, 0, 0);
  cam.once('camerafadeoutcomplete', () => {
    if (!scene.scene?.isActive(scene.scene.key)) return;
    EventBus.removeAllListeners('player-interact');
    scene.scene.start(SCENE_KEYS.TOWN, {
      spawnX: state.returnX,
      spawnY: state.returnY + 16,
      visitorName: state.player.visitorName,
    });
  });
}
