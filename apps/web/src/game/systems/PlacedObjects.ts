import Phaser from 'phaser';
import type { LocationId, WorldEvent, WorldObject } from '@town/contract';
import { WorldObjectsResponse } from '@town/contract';
import { EventBus } from '../EventBus';
import { placeTownObject } from '../objects/TownObjects';
import { FixtureRegistry } from '../objects/Fixtures';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';
import { pixelForZone } from '../data/zone-bounds';

// PlacedObjects (programmable world D1/D2) — the scene-side renderer for the
// canonical object graph. Two jobs:
//
//   1. AGENT-PLACED objects (ownerAgentId != null): fetch the authoritative
//      list on scene create and materialize each row whose placement targets
//      this scene via TownObjects; then keep it live off the raw world-event
//      stream (object.created/removed/moved/attached). These are the objects
//      place_object makes — an arcade cabinet Hobby set up, a shelf Writer
//      added.
//
//   2. CLICK-TO-OPEN: any object (placed OR seeded fixture) carrying attached
//      artifacts opens its most recent attachment (EventBus 'open-card-target'
//      → the App overlay's artifact reader — where interactive artifacts run
//      in the sandboxed ArtifactFrame). Seeded fixtures get the click hung on
//      their already-registered sprite via FixtureRegistry, unless the fixture
//      already has its own interaction (the payphone's pickup wins).
//
// Join-replay safety: object.* events are in WorldClient's TRANSIENT_ON_JOIN,
// so the initial fetch is the single hydration source; live events only ever
// arrive once. Everything here is defensive against double-apply anyway.

interface PlacedEntry {
  img: Phaser.GameObjects.Image;
  row: WorldObject;
  label?: Phaser.GameObjects.Text;
}

export class PlacedObjects {
  private readonly sprites = new Map<string, PlacedEntry>();
  private readonly rows = new Map<string, WorldObject>();
  private destroyed = false;

  private readonly onWorldEvent = (ev: WorldEvent) => {
    if (this.destroyed || !this.scene.scene.isActive()) return;
    switch (ev.type) {
      case 'object.created': {
        const p = ev.payload;
        const placement = p.placement ?? null;
        // Materialize a WorldObject-ish row from the event; the next full
        // fetch (scene re-entry) reconciles any drift.
        this.apply({
          id: p.objectId,
          template: p.template,
          displayName: p.displayName,
          locationId: p.location,
          zone: p.zone,
          placement: placement ? { scene: placement.scene, x: placement.x, y: placement.y } : null,
          state: {},
          affordances: [],
          kind: null,
          attachedArtifactIds: [],
          notes: [],
          ownerAgentId: p.agent,
          description: null,
          movable: true,
          createdAt: ev.ts,
          updatedAt: ev.ts,
        });
        break;
      }
      case 'object.removed': {
        const entry = this.sprites.get(ev.payload.objectId);
        if (entry) this.destroyEntry(ev.payload.objectId, entry);
        this.rows.delete(ev.payload.objectId);
        break;
      }
      case 'object.moved': {
        const entry = this.sprites.get(ev.payload.objectId);
        const target = pixelForZone(ev.payload.toZone);
        if (entry && target) {
          this.scene.tweens.add({ targets: entry.img, x: target.x, y: target.y, duration: 400 });
          entry.row = { ...entry.row, zone: ev.payload.toZone };
        }
        break;
      }
      case 'object.attached': {
        const row = this.rows.get(ev.payload.objectId);
        if (row) {
          const ids = row.attachedArtifactIds.filter((id) => id !== ev.payload.artifactId);
          ids.push(ev.payload.artifactId);
          const next = { ...row, attachedArtifactIds: ids };
          this.rows.set(row.id, next);
          const entry = this.sprites.get(row.id);
          if (entry) {
            entry.row = next;
            this.makeOpenable(entry.img, next);
          } else {
            this.wireSeededFixture(next);
          }
        }
        break;
      }
      default:
        break;
    }
  };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly fixtures?: FixtureRegistry,
    private readonly collideWith?: Phaser.GameObjects.GameObject,
  ) {
    EventBus.on('world-event', this.onWorldEvent);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.destroyed = true;
      EventBus.off('world-event', this.onWorldEvent);
      this.sprites.clear();
      this.rows.clear();
    });
    void this.hydrate();
  }

  private async hydrate(): Promise<void> {
    try {
      const base = resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);
      const res = await fetch(`${base}/world/objects`);
      if (!res.ok) return;
      const parsed = WorldObjectsResponse.parse(await res.json());
      if (this.destroyed) return;
      for (const row of parsed.objects) {
        this.rows.set(row.id, row);
        if (row.ownerAgentId) this.apply(row);
        else if (row.attachedArtifactIds.length > 0) this.wireSeededFixture(row);
      }
    } catch {
      // A dead world server just means no placed objects this visit.
    }
  }

  // Render one agent-placed row into this scene (no-op for other scenes / rows
  // without a resolvable position). Idempotent by object id.
  private apply(row: WorldObject): void {
    this.rows.set(row.id, row);
    if (this.sprites.has(row.id) || !row.template) return;
    const sceneKey = this.scene.scene.key;
    const pos =
      row.placement && row.placement.scene === sceneKey
        ? { x: row.placement.x, y: row.placement.y }
        : this.positionFromZone(row, sceneKey);
    if (!pos) return;
    const img = placeTownObject(this.scene, row.template, pos.x, pos.y, {
      depth: 20,
      collideWith: this.collideWith,
    });
    if (!img) return;
    const entry: PlacedEntry = { img, row };
    this.sprites.set(row.id, entry);
    this.makeOpenable(img, row);
  }

  private positionFromZone(row: WorldObject, sceneKey: string): { x: number; y: number } | null {
    const p = pixelForZone(row.zone);
    if (!p) return null;
    // pixelForZone knows the zone; confirm it's THIS scene via the bounds table
    // convention (zone ids are `<location>.<name>` and each maps to one scene).
    return row.placement && row.placement.scene !== sceneKey ? null : p;
  }

  // Hover placard + (when it has attachments) click-to-open.
  private makeOpenable(img: Phaser.GameObjects.Image, row: WorldObject): void {
    img.setInteractive({ useHandCursor: row.attachedArtifactIds.length > 0 });
    img.off('pointerover');
    img.off('pointerout');
    img.off('pointerdown');
    img.on('pointerover', () => {
      img.setTint(0xddddff);
      this.showPlacard(row, img);
    });
    img.on('pointerout', () => {
      img.clearTint();
      this.hidePlacard(row.id);
    });
    if (row.attachedArtifactIds.length > 0) {
      img.on(
        'pointerdown',
        (_p: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
          event.stopPropagation();
          const latest = row.attachedArtifactIds[row.attachedArtifactIds.length - 1];
          EventBus.emit('open-card-target', { href: `artifact:${latest}` });
        },
      );
    }
  }

  // Seeded fixtures (hand-placed by the scene, registered in FixtureRegistry):
  // when one carries attachments, hang the artifact-open click on its existing
  // sprite — unless the fixture already owns an interaction (payphone pickup).
  private wireSeededFixture(row: WorldObject): void {
    if (!this.fixtures) return;
    const location = row.locationId as LocationId;
    if (this.fixtures.isInteractive(location, row.displayName)) return;
    const target = this.fixtures.get(location, row.displayName);
    const obj = target?.obj;
    if (!obj) return;
    obj.setInteractive({ useHandCursor: true });
    obj.off('pointerdown');
    obj.on(
      'pointerdown',
      (_p: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        const fresh = this.rows.get(row.id) ?? row;
        const latest = fresh.attachedArtifactIds[fresh.attachedArtifactIds.length - 1];
        if (latest) EventBus.emit('open-card-target', { href: `artifact:${latest}` });
      },
    );
  }

  private showPlacard(row: WorldObject, img: Phaser.GameObjects.Image): void {
    const entry = this.sprites.get(row.id);
    if (!entry || entry.label) return;
    const fresh = this.rows.get(row.id) ?? row;
    const who = fresh.ownerAgentId ? `placed by ${fresh.ownerAgentId}` : 'part of the town';
    const openable = fresh.attachedArtifactIds.length > 0 ? ' · click to open' : '';
    entry.label = this.scene.add
      .text(img.x, img.y - img.displayHeight - 4, `${fresh.displayName}\n${who}${openable}`, {
        fontFamily: 'monospace',
        fontSize: '8px',
        color: '#fffbe8',
        stroke: '#1a1a2e',
        strokeThickness: 3,
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setDepth(6000);
  }

  private hidePlacard(objectId: string): void {
    const entry = this.sprites.get(objectId);
    entry?.label?.destroy();
    if (entry) entry.label = undefined;
  }

  private destroyEntry(id: string, entry: PlacedEntry): void {
    entry.label?.destroy();
    const zone = (entry.img as Phaser.GameObjects.Image & { collisionZone?: Phaser.GameObjects.Zone })
      .collisionZone;
    zone?.destroy();
    entry.img.destroy();
    this.sprites.delete(id);
  }
}
