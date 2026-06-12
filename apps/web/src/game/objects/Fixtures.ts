import Phaser from 'phaser';
import type { LocationId } from '@town/contract';
import { EventBus } from '../EventBus';

// Scene-side fixture embodiment (translation-layer Step 2). Scenes register the
// sprite (or bare point) that embodies a world fixture; the registry consumes
// EventBus 'fixture-effect' (contract world.effect) and plays the effect on the
// actual object — before this, an agent could `use_fixture` the office phone
// and nothing would happen on screen.
//
// Registration is keyed (locationId, fixtureId) using the world's fixture ids
// (seed.ts is the source of truth: office "phone" rings, library/workshop
// "lamp" flickers, cafe "espresso machine" hisses, town "notice board"
// rustles, park "payphone" rings). A scene can host several locations (Town =
// town + park), so the location is per-registration, not per-scene.

export interface FixtureTarget {
  x: number;
  y: number;
  obj?: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite;
}

export interface RegisterOpts {
  // Make the fixture visitor-clickable: pointer cursor + a click emits
  // 'visitor-interact' (→ POST /visitors/:id/interact; the world routes it to
  // a live chat or the next tick's perception).
  interactive?: boolean;
}

export class FixtureRegistry {
  private readonly entries = new Map<string, FixtureTarget>();
  private readonly handler: (p: {
    location: LocationId;
    fixture: string;
    effect: string;
  }) => void;

  constructor(private readonly scene: Phaser.Scene) {
    this.handler = (p) => {
      // Only play effects for fixtures this scene registered (which scopes by
      // location implicitly) and only while the scene is actually live.
      if (!this.scene.scene.isActive()) return;
      const entry = this.entries.get(key(p.location, p.fixture));
      if (entry) playEffect(this.scene, entry, p.effect);
    };
    EventBus.on('fixture-effect', this.handler);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      EventBus.off('fixture-effect', this.handler);
      this.entries.clear();
    });
  }

  // Register the embodiment of a world fixture. `target` is the placed object
  // (preferred — effects animate it) or a bare {x, y} for fixtures the map
  // draws as tiles / doesn't draw yet (effects play as floating text there).
  register(
    locationId: LocationId,
    fixtureId: string,
    target: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | { x: number; y: number },
    opts: RegisterOpts = {},
  ): void {
    const entry: FixtureTarget =
      target instanceof Phaser.GameObjects.GameObject
        ? { x: target.x, y: target.y, obj: target }
        : { x: target.x, y: target.y };
    this.entries.set(key(locationId, fixtureId), entry);

    if (opts.interactive && entry.obj) {
      const obj = entry.obj;
      obj.setInteractive({ useHandCursor: true });
      obj.on('pointerover', () => obj.setTint(0xddddff));
      obj.on('pointerout', () => obj.clearTint());
      obj.on(
        'pointerdown',
        (_p: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
          // Don't ALSO walk the player to the click (scene-level tap-move).
          event.stopPropagation();
          playEffect(this.scene, entry, 'nudge');
          EventBus.emit('visitor-interact', { locationId, fixture: fixtureId });
        },
      );
    }
  }
}

function key(locationId: string, fixtureId: string): string {
  return `${locationId}::${fixtureId}`;
}

// Effect-capable world fixtures (seed.ts) → where they live in each interior,
// in world px. These match the placed fixture sprites (each scene registers
// the actual sprite over its point in create), so the point doubles as a
// fallback if a sprite fails to place. Verified with render_map.py.
export const INTERIOR_FIXTURE_POINTS: Partial<Record<LocationId, Record<string, { x: number; y: number }>>> = {
  office: { phone: { x: 58, y: 120 } },
  library: { lamp: { x: 95, y: 180 } },
  workshop: { lamp: { x: 52, y: 148 }, monitor: { x: 137, y: 75 } },
  cafe: { 'espresso machine': { x: 57, y: 117 } },
};

// --- effect rendering --------------------------------------------------------
// Small, legible, self-cleaning. Every effect = an optional tween on the object
// + a floating caption near it; specific effects add their own garnish.

const CAPTIONS: Record<string, string> = {
  ring: '♪ ring ring ♪',
  flicker: '✦',
  hiss: 'psssht…',
  rustle: 'fwip fwip',
  nudge: '',
};

function playEffect(scene: Phaser.Scene, entry: FixtureTarget, effect: string): void {
  const { x, y, obj } = entry;
  const caption = CAPTIONS[effect] ?? `*${effect}*`;

  switch (effect) {
    case 'ring':
    case 'rustle':
      // Wobble in place (angle, not position — collision zones stay put).
      if (obj) {
        scene.tweens.add({
          targets: obj,
          angle: { from: -3, to: 3 },
          duration: 70,
          yoyo: true,
          repeat: 7,
          onComplete: () => obj.setAngle(0),
        });
      }
      break;
    case 'flicker': {
      // Light pulse: the object (or a glow disc at the point) blinks.
      const target = obj ?? scene.add.circle(x, y - 8, 6, 0xfff3b0, 0.8).setDepth(5000);
      scene.tweens.add({
        targets: target,
        alpha: { from: 1, to: 0.25 },
        duration: 90,
        yoyo: true,
        repeat: 5,
        onComplete: () => {
          if (obj) obj.setAlpha(1);
          else target.destroy();
        },
      });
      break;
    }
    case 'hiss': {
      // Three steam puffs drifting up.
      for (let i = 0; i < 3; i++) {
        const puff = scene.add.circle(x + (i - 1) * 4, y - 12, 3, 0xffffff, 0.7).setDepth(5000);
        scene.tweens.add({
          targets: puff,
          y: y - 28 - i * 4,
          alpha: 0,
          scale: 2,
          delay: i * 140,
          duration: 700,
          onComplete: () => puff.destroy(),
        });
      }
      break;
    }
    case 'nudge':
      if (obj) {
        scene.tweens.add({
          targets: obj,
          scaleX: obj.scaleX * 1.06,
          scaleY: obj.scaleY * 1.06,
          duration: 80,
          yoyo: true,
        });
      }
      break;
    default:
      if (obj) {
        scene.tweens.add({
          targets: obj,
          y: obj.y - 2,
          duration: 90,
          yoyo: true,
          onComplete: () => obj.setY(y),
        });
      }
  }

  if (caption) {
    const label = scene.add
      .text(x, y - (obj ? obj.displayHeight : 16) - 6, caption, {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#fffbe8',
        stroke: '#1a1a2e',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(6000);
    scene.tweens.add({
      targets: label,
      y: label.y - 14,
      alpha: { from: 1, to: 0 },
      delay: 500,
      duration: 900,
      onComplete: () => label.destroy(),
    });
  }
}
