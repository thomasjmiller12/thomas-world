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

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'player', 0);

    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setCollideWorldBounds(true);
    this.setSize(10, 10);
    this.setOffset(3, 20);
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

    EventBus.on('chat-opened', () => {
      this.isInteracting = true;
      this.scene.input.keyboard?.disableGlobalCapture();
    });
    EventBus.on('chat-closed', () => {
      this.isInteracting = false;
      this.scene.input.keyboard?.enableGlobalCapture();
    });
    EventBus.on('dialog-opened', () => {
      this.isInteracting = true;
      this.scene.input.keyboard?.disableGlobalCapture();
    });
    EventBus.on('dialog-closed', () => {
      this.isInteracting = false;
      this.scene.input.keyboard?.enableGlobalCapture();
    });
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

    this.setFlipX(this.direction === 'left');

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
    EventBus.off('chat-opened');
    EventBus.off('chat-closed');
    EventBus.off('dialog-opened');
    EventBus.off('dialog-closed');
    super.destroy(fromScene);
  }
}
