import Phaser from 'phaser';
import { NPC_SPEED, INTERACTION_RANGE } from '@/lib/constants';
import { NPCConfig, ThomasId } from '@/lib/types';
import { EventBus } from '../EventBus';

// One of:
//  - wander:   idle local flourish (waypoint roaming) — the default for an
//              agent standing around with nothing happening.
//  - walking:  a directed walk to a target (arrival from / departure to a door),
//              driven by the NPCManager; calls back on arrival.
//  - engaged:  facing the player (visitor is chatting with this agent). The
//              agent can still leave mid-chat — an arrival/departure flips it
//              back to walking, then wander.
export type NPCState = 'wander' | 'walking' | 'engaged';

export class NPC extends Phaser.Physics.Arcade.Sprite {
  readonly npcId: ThomasId;
  readonly displayName: string;
  readonly npcConfig: NPCConfig;

  private waypoints: { x: number; y: number }[];
  private currentWaypointIndex: number = 0;
  private direction: string = 'down';
  private isPaused: boolean = false;
  // Remaining legs of an A* route (walkPath); consumed by the arrival branch.
  private pathQueue: { x: number; y: number }[] = [];
  // Stall detector for walk legs: see update().
  private stallX = 0;
  private stallY = 0;
  private stallFrames = 0;
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

    // Animated "…" bubble — a proximity hint ("talk to me") shown when the
    // visitor is in range of an idle agent.
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
    this.pathQueue = [];
    this.onArrive = done ?? null;
    this.isPaused = false;
    this.stallFrames = 0;
    this.stallX = this.x;
    this.stallY = this.y;
    if (this.pauseTimer) this.pauseTimer.destroy();
  }

  // Directed walk along an A*-computed route (a list of world points). Each leg
  // reuses the walking state machine; `done` fires once after the LAST leg.
  walkPath(points: { x: number; y: number }[], done?: () => void): void {
    if (points.length === 0) {
      done?.();
      return;
    }
    this.walkTo(points[0], done);
    this.pathQueue = points.slice(1).map((p) => ({ x: p.x, y: p.y }));
  }

  // Faces the player and stops (visitor opened a chat).
  enterEngaged(playerX: number, playerY: number): void {
    this.npcState = 'engaged';
    this.walkTarget = null;
    this.pathQueue = [];
    this.onArrive = null;
    this.setVelocity(0, 0);
    if (this.pauseTimer) this.pauseTimer.destroy();
    this.facePlayer(playerX, playerY);
  }

  getState(): NPCState {
    return this.npcState;
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
      // Stall = arrived: the walk is straight-line with no pathfinding, so a
      // wall on the line (or an anchor on a collision tile) would otherwise trap
      // the sprite in 'walking' forever — bumping the wall AND excluded from
      // interaction targeting. Barely moving for ~15 frames → stop where it is
      // and fire the arrival callback so the agent still applies its state.
      const moved = Math.hypot(this.x - this.stallX, this.y - this.stallY);
      this.stallFrames = moved < 0.3 ? this.stallFrames + 1 : 0;
      this.stallX = this.x;
      this.stallY = this.y;
      if (dist < 4 || this.stallFrames > 15) {
        this.stallFrames = 0;
        // More legs queued (A* route) → advance to the next one. A stalled leg
        // also advances: the next leg usually routes around whatever blocked us.
        if (this.pathQueue.length > 0) {
          this.walkTarget = this.pathQueue.shift()!;
          return;
        }
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
        // Same stall guard for wander legs: a blocked waypoint advances to the
        // next one instead of walking into the wall until the heat death of the town.
        const moved = Math.hypot(this.x - this.stallX, this.y - this.stallY);
        this.stallFrames = moved < 0.3 ? this.stallFrames + 1 : 0;
        this.stallX = this.x;
        this.stallY = this.y;
        if (dist < 4 || this.stallFrames > 15) {
          this.stallFrames = 0;
          this.arriveAtWaypoint();
        }
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
