import Phaser from 'phaser';
import { NPC_SPEED, INTERACTION_RANGE } from '@/lib/constants';
import { NPCConfig, ThomasId } from '@/lib/types';
import { EventBus } from '../EventBus';

// One of:
//  - wander:   idle local flourish (waypoint roaming) — the default for an
//              agent standing in a scene with nothing happening.
//  - walking:  a directed walk to a target (arrival from / departure to a door),
//              driven by the NPCManager; calls back on arrival.
//  - in-scene: parked in a live agent↔agent conversation, facing the partner;
//              the *next speaker* shows the animated "…" thinking bubble.
//  - engaged:  facing the player (visitor opened a chat).
export type NPCState = 'wander' | 'walking' | 'in-scene' | 'engaged';

export class NPC extends Phaser.Physics.Arcade.Sprite {
  readonly npcId: ThomasId;
  readonly displayName: string;
  readonly npcConfig: NPCConfig;

  private waypoints: { x: number; y: number }[];
  private currentWaypointIndex: number = 0;
  private direction: string = 'down';
  private isPaused: boolean = false;
  private pauseTimer?: Phaser.Time.TimerEvent;
  private colorDot: Phaser.GameObjects.Arc;
  private thinkingBubble: Phaser.GameObjects.Graphics;
  private wasInRange: boolean = false;

  private npcState: NPCState = 'wander';
  // Directed-walk target + arrival callback (walking state).
  private walkTarget: { x: number; y: number } | null = null;
  private onArrive: (() => void) | null = null;

  constructor(scene: Phaser.Scene, config: NPCConfig) {
    super(scene, config.homePosition.x, config.homePosition.y, config.sprite, 0);

    this.npcId = config.id;
    this.displayName = config.displayName;
    this.npcConfig = config;
    this.waypoints = config.waypoints;

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setCollideWorldBounds(true);
    this.setSize(10, 10);
    this.setOffset(3, 12);
    this.setDepth(16);
    this.setImmovable(true);

    // Small colored dot above the NPC
    const colorInt = Phaser.Display.Color.HexStringToColor(config.color).color;
    this.colorDot = scene.add.circle(this.x, this.y - 14, 3, colorInt);
    this.colorDot.setDepth(20);

    // Animated "…" thinking bubble — shown for the next speaker between scene
    // turns (the dead-air-is-thinking cue, design doc §3.1) and on proximity.
    this.thinkingBubble = scene.add.graphics();
    this.thinkingBubble.setDepth(21);
    this.thinkingBubble.setVisible(false);
    this.drawThinkingBubble();

    this.startWaypoints();
  }

  private drawThinkingBubble() {
    const g = this.thinkingBubble;
    g.clear();

    // Small white rounded rectangle
    g.fillStyle(0xffffff, 0.95);
    g.fillRoundedRect(-10, -10, 20, 12, 3);

    // Tiny pointer triangle
    g.fillTriangle(-2, 2, 2, 2, 0, 5);

    // Three dots
    g.fillStyle(0x666666, 1);
    g.fillCircle(-4, -4, 1.5);
    g.fillCircle(0, -4, 1.5);
    g.fillCircle(4, -4, 1.5);
  }

  // --- waypoint wander (idle flourish, the default state) -------------------

  private startWaypoints() {
    this.moveToWaypoint();
  }

  private moveToWaypoint() {
    if (this.npcState !== 'wander' || !this.scene || !this.active) return;

    const target = this.waypoints[this.currentWaypointIndex];
    if (!target) return;
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      this.arriveAtWaypoint();
      return;
    }

    const vx = (dx / dist) * NPC_SPEED;
    const vy = (dy / dist) * NPC_SPEED;
    this.setVelocity(vx, vy);
    this.faceVelocity(dx, dy);
    this.play(`${this.npcConfig.sprite}-walk-${this.direction}`, true);
  }

  private arriveAtWaypoint() {
    this.setVelocity(0, 0);
    this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
    this.isPaused = true;

    const pauseDuration = Phaser.Math.Between(3000, 8000);
    this.pauseTimer = this.scene.time.delayedCall(pauseDuration, () => {
      if (this.npcState !== 'wander') return;
      this.isPaused = false;
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
      this.moveToWaypoint();
    });
  }

  // --- state transitions (driven by the NPCManager) -------------------------

  // Resume local idle wandering from wherever the sprite currently stands. The
  // waypoint loop is re-seeded around the supplied home anchor so a guest agent
  // doesn't wander back across the room toward the resident's path.
  enterWander(home?: { x: number; y: number }): void {
    this.npcState = 'wander';
    this.walkTarget = null;
    this.onArrive = null;
    this.isPaused = false;
    if (home) {
      this.waypoints = [
        { x: home.x, y: home.y },
        { x: home.x + 32, y: home.y },
        { x: home.x, y: home.y + 24 },
      ];
      this.currentWaypointIndex = 0;
    }
    this.moveToWaypoint();
  }

  // Directed walk to a point; `done` fires once on arrival. Used for arrivals
  // (walk in from the door) and departures (walk to the door, then despawn).
  walkTo(target: { x: number; y: number }, done?: () => void): void {
    this.npcState = 'walking';
    this.walkTarget = { x: target.x, y: target.y };
    this.onArrive = done ?? null;
    this.isPaused = false;
    if (this.pauseTimer) this.pauseTimer.destroy();
  }

  // Parked in a live scene, facing a partner sprite. Idle (no roaming).
  enterScene(faceTarget?: { x: number; y: number }): void {
    this.npcState = 'in-scene';
    this.walkTarget = null;
    this.onArrive = null;
    this.setVelocity(0, 0);
    if (this.pauseTimer) this.pauseTimer.destroy();
    if (faceTarget) {
      this.faceVelocity(faceTarget.x - this.x, faceTarget.y - this.y);
    }
    this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
  }

  // Faces the player and stops (visitor opened a chat).
  enterEngaged(playerX: number, playerY: number): void {
    this.npcState = 'engaged';
    this.walkTarget = null;
    this.onArrive = null;
    this.setVelocity(0, 0);
    if (this.pauseTimer) this.pauseTimer.destroy();
    this.facePlayer(playerX, playerY);
  }

  getState(): NPCState {
    return this.npcState;
  }

  // Show/hide the animated "…" bubble (the next speaker shows it between turns).
  setThinking(on: boolean): void {
    this.thinkingBubble.setVisible(on);
  }

  // --- facing helpers -------------------------------------------------------

  private faceVelocity(dx: number, dy: number): void {
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx > absDy * 1.5) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else if (absDy > absDx * 1.5) {
      this.direction = dy > 0 ? 'down' : 'up';
    }
  }

  facePlayer(playerX: number, playerY: number) {
    const dx = playerX - this.x;
    const dy = playerY - this.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else {
      this.direction = dy > 0 ? 'down' : 'up';
    }
    this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
  }

  // --- proximity (interaction targeting) ------------------------------------

  checkProximity(playerX: number, playerY: number) {
    const inRange = this.isPlayerInRange(playerX, playerY);
    if (inRange && !this.wasInRange) {
      // Only flash the proximity hint when idle — a sprite mid-scene or walking
      // shouldn't pop a "talk to me" bubble.
      if (this.npcState === 'wander') this.thinkingBubble.setVisible(true);
      EventBus.emit('npc-proximity-enter', { npcId: this.npcId });
    } else if (!inRange && this.wasInRange) {
      if (this.npcState === 'wander') this.thinkingBubble.setVisible(false);
      EventBus.emit('npc-proximity-exit', { npcId: this.npcId });
    }
    this.wasInRange = inRange;
  }

  isPlayerInRange(playerX: number, playerY: number): boolean {
    const dist = Phaser.Math.Distance.Between(this.x, this.y, playerX, playerY);
    return dist <= INTERACTION_RANGE;
  }

  // --- per-frame update -----------------------------------------------------

  update() {
    this.colorDot.setPosition(this.x, this.y - 14);
    this.thinkingBubble.setPosition(this.x, this.y - 22);

    if (this.npcState === 'walking' && this.walkTarget) {
      const dx = this.walkTarget.x - this.x;
      const dy = this.walkTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 4) {
        this.setVelocity(0, 0);
        this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
        const cb = this.onArrive;
        this.walkTarget = null;
        this.onArrive = null;
        cb?.();
      } else {
        const vx = (dx / dist) * NPC_SPEED;
        const vy = (dy / dist) * NPC_SPEED;
        this.setVelocity(vx, vy);
        this.faceVelocity(dx, dy);
        this.play(`${this.npcConfig.sprite}-walk-${this.direction}`, true);
      }
    } else if (this.npcState === 'wander' && !this.isPaused) {
      const target = this.waypoints[this.currentWaypointIndex];
      if (target) {
        const dist = Phaser.Math.Distance.Between(this.x, this.y, target.x, target.y);
        if (dist < 4) this.arriveAtWaypoint();
      }
    }

    const camera = this.scene?.cameras?.main;
    if (camera) {
      const screenX = (this.x - camera.scrollX) * camera.zoom;
      const screenY = (this.y - camera.scrollY) * camera.zoom;
      EventBus.emit('npc-screen-position', {
        npcId: this.npcId,
        screenX,
        screenY,
      });
    }
  }

  destroy(fromScene?: boolean) {
    this.colorDot?.destroy();
    this.thinkingBubble?.destroy();
    this.pauseTimer?.destroy();
    super.destroy(fromScene);
  }
}
