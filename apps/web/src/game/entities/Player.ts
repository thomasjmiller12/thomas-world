import Phaser from 'phaser';
import { PLAYER_SPEED, INTERACTION_RANGE } from '@/lib/constants';
import { EventBus } from '../EventBus';

export class Player extends Phaser.Physics.Arcade.Sprite {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private interactKey!: Phaser.Input.Keyboard.Key;
  private direction: string = 'down';
  private isInteracting: boolean = false;
  visitorName: string = 'Visitor';
  // Tap-to-move target (minimal touch, design §6.3). When set, the player walks
  // toward it in a straight line; cleared on arrival, on a collision stall, or
  // when the visitor takes keyboard control. Position is in world coordinates.
  private tapTarget: { x: number; y: number } | null = null;
  // Stall detector: if we've barely moved for a few frames while still far from
  // the target, a wall is in the way — stop (straight-line walk with collision
  // stop, no pathfinding, per the design's "minimal" scope).
  private stallX = 0;
  private stallY = 0;
  private stallFrames = 0;
  private static readonly TAP_ARRIVE_DIST = 6;
  // Scoped handler refs so destroy() removes ONLY this player's listeners.
  private readonly onChatOpened = () => {
    this.isInteracting = true;
    this.scene.input.keyboard?.disableGlobalCapture();
  };
  private readonly onChatClosed = () => {
    this.isInteracting = false;
    this.scene.input.keyboard?.enableGlobalCapture();
  };
  private readonly onDialogOpened = () => {
    this.isInteracting = true;
    this.scene.input.keyboard?.disableGlobalCapture();
  };
  private readonly onDialogClosed = () => {
    this.isInteracting = false;
    this.scene.input.keyboard?.enableGlobalCapture();
  };
  private readonly onTapMove = (p: { worldX: number; worldY: number }) => {
    if (this.isInteracting) return;
    this.tapTarget = { x: p.worldX, y: p.worldY };
    this.stallFrames = 0;
    this.stallX = this.x;
    this.stallY = this.y;
  };

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'player', 0);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setCollideWorldBounds(true);
    this.setSize(10, 10);
    this.setOffset(3, 12);
    this.setDepth(16);

    if (scene.input.keyboard) {
      this.cursors = scene.input.keyboard.createCursorKeys();
      this.wasd = {
        W: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        A: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        S: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        D: scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      };
      this.interactKey = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

      this.interactKey.on('down', () => {
        if (!this.isInteracting) {
          EventBus.emit('player-interact', { x: this.x, y: this.y, direction: this.direction });
        }
      });
    }

    EventBus.on('chat-opened', this.onChatOpened);
    EventBus.on('chat-closed', this.onChatClosed);
    EventBus.on('dialog-opened', this.onDialogOpened);
    EventBus.on('dialog-closed', this.onDialogClosed);
    EventBus.on('tap-move', this.onTapMove);
  }

  update() {
    if (this.isInteracting) {
      this.setVelocity(0, 0);
      this.play(`player-idle-${this.direction}`, true);
      return;
    }

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);

    let moving = false;
    const up = this.cursors?.up.isDown || this.wasd?.W.isDown;
    const down = this.cursors?.down.isDown || this.wasd?.S.isDown;
    const left = this.cursors?.left.isDown || this.wasd?.A.isDown;
    const right = this.cursors?.right.isDown || this.wasd?.D.isDown;

    // Keyboard input always cancels an active tap-walk (visitor took over).
    if ((up || down || left || right) && this.tapTarget) {
      this.tapTarget = null;
    }

    // Tap-to-move: straight-line walk toward the target until we arrive or stall
    // against a wall (collision stop). Keyboard handling below is skipped while
    // a tap-walk is active.
    if (this.tapTarget) {
      const dx = this.tapTarget.x - this.x;
      const dy = this.tapTarget.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= Player.TAP_ARRIVE_DIST) {
        this.tapTarget = null;
      } else {
        body.setVelocity((dx / dist) * PLAYER_SPEED, (dy / dist) * PLAYER_SPEED);
        this.direction = Math.abs(dx) > Math.abs(dy)
          ? (dx < 0 ? 'left' : 'right')
          : (dy < 0 ? 'up' : 'down');
        // Stall check: barely moved over ~8 frames while still far → blocked.
        const moved = Math.hypot(this.x - this.stallX, this.y - this.stallY);
        if (moved < 0.5) {
          this.stallFrames++;
          if (this.stallFrames > 8) this.tapTarget = null;
        } else {
          this.stallFrames = 0;
        }
        this.stallX = this.x;
        this.stallY = this.y;
        this.play(`player-walk-${this.direction}`, true);
        return;
      }
    }

    if (left) {
      body.setVelocityX(-PLAYER_SPEED);
      moving = true;
    } else if (right) {
      body.setVelocityX(PLAYER_SPEED);
      moving = true;
    }

    if (up) {
      body.setVelocityY(-PLAYER_SPEED);
      moving = true;
    } else if (down) {
      body.setVelocityY(PLAYER_SPEED);
      moving = true;
    }

    if (body.velocity.x !== 0 && body.velocity.y !== 0) {
      body.velocity.normalize().scale(PLAYER_SPEED);
    }

    if (moving) {
      if (up && !left && !right) this.direction = 'up';
      else if (down && !left && !right) this.direction = 'down';
      else if (left) this.direction = 'left';
      else if (right) this.direction = 'right';
    }

    if (moving) {
      this.play(`player-walk-${this.direction}`, true);
    } else {
      this.play(`player-idle-${this.direction}`, true);
    }
  }

  getInteractionPoint(): { x: number; y: number } {
    const offset = INTERACTION_RANGE / 2;
    switch (this.direction) {
      case 'up': return { x: this.x, y: this.y - offset };
      case 'down': return { x: this.x, y: this.y + offset };
      case 'left': return { x: this.x - offset, y: this.y };
      case 'right': return { x: this.x + offset, y: this.y };
      default: return { x: this.x, y: this.y };
    }
  }

  destroy(fromScene?: boolean) {
    EventBus.off('chat-opened', this.onChatOpened);
    EventBus.off('chat-closed', this.onChatClosed);
    EventBus.off('dialog-opened', this.onDialogOpened);
    EventBus.off('dialog-closed', this.onDialogClosed);
    EventBus.off('tap-move', this.onTapMove);
    super.destroy(fromScene);
  }
}
