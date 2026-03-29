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
  private nameTag?: Phaser.GameObjects.Sprite;
  private interactionIndicator?: Phaser.GameObjects.Sprite;
  private isInConversation: boolean = false;

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
    this.setOffset(3, 20);
    this.setDepth(16);
    this.setImmovable(true);

    // Render text to texture once to avoid per-frame text rendering artifacts
    this.nameTag = this.createTextSprite(scene, `npc-name-${config.id}`, this.displayName, {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '18px',
      fontStyle: 'bold',
      color: config.color,
      stroke: '#000000',
      strokeThickness: 3,
    }, 0.5);
    this.nameTag.setPosition(this.x, this.y - 20);
    this.nameTag.setDepth(20);

    this.interactionIndicator = this.createTextSprite(scene, `npc-space-${config.id}`, '[SPACE]', {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: '16px',
      fontStyle: 'bold',
      color: '#ffff00',
      stroke: '#000000',
      strokeThickness: 3,
    }, 0.5);
    this.interactionIndicator.setPosition(this.x, this.y - 30);
    this.interactionIndicator.setDepth(20);
    this.interactionIndicator.setVisible(false);

    this.startWaypoints();

    EventBus.on('chat-opened', (data: { npcId: string }) => {
      if (data.npcId === this.npcId) {
        this.isInConversation = true;
        this.setVelocity(0, 0);
      }
    });

    EventBus.on('chat-closed', (data: { npcId: string }) => {
      if (data.npcId === this.npcId) {
        this.isInConversation = false;
      }
    });
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

    this.setFlipX(this.direction === 'left');
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
    this.setFlipX(this.direction === 'left');
    this.play(`${this.npcConfig.sprite}-idle-${this.direction}`, true);
  }

  showInteractionIndicator(show: boolean) {
    this.interactionIndicator?.setVisible(show);
  }

  isPlayerInRange(playerX: number, playerY: number): boolean {
    const dist = Phaser.Math.Distance.Between(this.x, this.y, playerX, playerY);
    return dist <= INTERACTION_RANGE;
  }

  update() {
    if (this.nameTag) {
      this.nameTag.setPosition(this.x, this.y - 20);
    }
    if (this.interactionIndicator) {
      this.interactionIndicator.setPosition(this.x, this.y - 26);
    }

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

  private createTextSprite(
    scene: Phaser.Scene,
    key: string,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
    scale: number,
  ): Phaser.GameObjects.Sprite {
    // Render at 2x size then display at half scale for crisp text
    const tmp = scene.add.text(0, 0, text, style).setOrigin(0.5);
    const w = Math.ceil(tmp.width) + 4;
    const h = Math.ceil(tmp.height) + 4;
    const rt = scene.textures.createCanvas(key, w, h);
    const ctx = rt!.getContext();
    tmp.setPosition(w / 2, h / 2);
    // Draw text onto canvas
    const textCanvas = tmp.canvas;
    ctx.drawImage(textCanvas, (w - tmp.width) / 2, (h - tmp.height) / 2);
    rt!.refresh();
    tmp.destroy();

    const sprite = scene.add.sprite(0, 0, key);
    sprite.setOrigin(0.5);
    sprite.setScale(scale);
    return sprite;
  }

  destroy(fromScene?: boolean) {
    this.nameTag?.destroy();
    this.interactionIndicator?.destroy();
    this.pauseTimer?.destroy();
    super.destroy(fromScene);
  }
}
