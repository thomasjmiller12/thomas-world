import Phaser from 'phaser';
import { NPC_SPEED, INTERACTION_RANGE } from '@/lib/constants';
import { NPCConfig, ThomasId } from '@/lib/types';
import { EventBus } from '../EventBus';

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
  private speechBubble: Phaser.GameObjects.Graphics;
  private isInConversation: boolean = false;
  private wasInRange: boolean = false;
  // Scoped handler refs so destroy() removes ONLY this NPC's listeners
  // (previously anonymous + never removed → a leak across scene transitions).
  private readonly onChatOpened = (data: { npcId: ThomasId }) => {
    if (data.npcId === this.npcId) {
      this.isInConversation = true;
      this.setVelocity(0, 0);
    }
  };
  private readonly onChatClosed = (data: { npcId: ThomasId }) => {
    if (data.npcId === this.npcId) {
      this.isInConversation = false;
    }
  };

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

    // Speech bubble (hidden until proximity)
    this.speechBubble = scene.add.graphics();
    this.speechBubble.setDepth(21);
    this.speechBubble.setVisible(false);
    this.drawSpeechBubble();

    this.startWaypoints();

    EventBus.on('chat-opened', this.onChatOpened);
    EventBus.on('chat-closed', this.onChatClosed);
  }

  private drawSpeechBubble() {
    const g = this.speechBubble;
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

  private startWaypoints() {
    this.moveToWaypoint();
  }

  private moveToWaypoint() {
    if (this.isInConversation || !this.scene || !this.active) return;

    const target = this.waypoints[this.currentWaypointIndex];
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

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx > absDy * 1.5) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else if (absDy > absDx * 1.5) {
      this.direction = dy > 0 ? 'down' : 'up';
    }

    this.play(`${this.npcConfig.sprite}-walk-${this.direction}`, true);
  }

  private arriveAtWaypoint() {
    this.setVelocity(0, 0);
    this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
    this.isPaused = true;

    const pauseDuration = Phaser.Math.Between(3000, 8000);
    this.pauseTimer = this.scene.time.delayedCall(pauseDuration, () => {
      this.isPaused = false;
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
      this.moveToWaypoint();
    });
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

  checkProximity(playerX: number, playerY: number) {
    const inRange = this.isPlayerInRange(playerX, playerY);
    if (inRange && !this.wasInRange) {
      this.speechBubble.setVisible(true);
      EventBus.emit('npc-proximity-enter', { npcId: this.npcId });
    } else if (!inRange && this.wasInRange) {
      this.speechBubble.setVisible(false);
      EventBus.emit('npc-proximity-exit', { npcId: this.npcId });
    }
    this.wasInRange = inRange;
  }

  isPlayerInRange(playerX: number, playerY: number): boolean {
    const dist = Phaser.Math.Distance.Between(this.x, this.y, playerX, playerY);
    return dist <= INTERACTION_RANGE;
  }

  update() {
    this.colorDot.setPosition(this.x, this.y - 14);
    this.speechBubble.setPosition(this.x, this.y - 22);

    if (!this.isPaused && !this.isInConversation) {
      const target = this.waypoints[this.currentWaypointIndex];
      const dist = Phaser.Math.Distance.Between(this.x, this.y, target.x, target.y);
      if (dist < 4) {
        this.arriveAtWaypoint();
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
    EventBus.off('chat-opened', this.onChatOpened);
    EventBus.off('chat-closed', this.onChatClosed);
    this.colorDot?.destroy();
    this.speechBubble?.destroy();
    this.pauseTimer?.destroy();
    super.destroy(fromScene);
  }
}
