import Phaser from 'phaser';

// Drop-in placement for the named LimeZu object library
// (apps/web/public/assets/objects, built by scripts/objects/*.py).
//
// The library manifest (library.json) is loaded into the Phaser JSON cache via
// the 'town-objects' entry in the preload asset pack, and each category's atlas
// as 'obj-<category>'. An object's NAME is the shared vocabulary that threads
// agent fixture → @town/contract → this helper → (later) visitor-clickable.

export interface TownObjectDef {
  category: string;
  atlasKey: string; // loaded atlas texture key, e.g. 'obj-street'
  frame: string; // atlas frame = the object's name
  px: { w: number; h: number };
  tiles: { w: number; h: number };
  collides: boolean;
  tags: string[];
}

interface TownObjectLibrary {
  version: number;
  categories: Record<string, { atlas: string; json: string; count: number }>;
  objects: Record<string, TownObjectDef>;
}

const CACHE_KEY = 'town-objects';

export function getTownObjectLibrary(scene: Phaser.Scene): TownObjectLibrary | null {
  return (scene.cache.json.get(CACHE_KEY) as TownObjectLibrary | undefined) ?? null;
}

export function townObjectDef(scene: Phaser.Scene, name: string): TownObjectDef | null {
  return getTownObjectLibrary(scene)?.objects[name] ?? null;
}

export interface PlaceOpts {
  // Origin within the sprite. Default [0.5, 1] = bottom-center, so the object
  // sits on its footprint at (x, y) — the natural anchor for a grounded prop.
  origin?: [number, number];
  depth?: number;
  scale?: number;
  // When the object collides (or this is set), add an invisible static body at
  // the object's BASE footprint and a collider against `collideWith` (e.g. the
  // player). Decoupled from the sprite so the tall top can overlap visually while
  // only the base blocks movement — the natural feel for a prop.
  collideWith?: Phaser.GameObjects.GameObject | Phaser.GameObjects.GameObject[];
  // Height of the base collision band, in tiles (default 1).
  footprintTiles?: number;
}

// Place a named object from the library into a scene. Returns the Image, or null
// if the object name is unknown or its atlas isn't loaded (logged, never throws).
export function placeTownObject(
  scene: Phaser.Scene,
  name: string,
  x: number,
  y: number,
  opts: PlaceOpts = {},
): Phaser.GameObjects.Image | null {
  const lib = getTownObjectLibrary(scene);
  const def = lib?.objects[name];
  if (!def) {
    console.warn(`[TownObjects] unknown object "${name}" (library ${lib ? 'loaded' : 'NOT loaded'})`);
    return null;
  }
  if (!scene.textures.exists(def.atlasKey)) {
    console.warn(`[TownObjects] atlas "${def.atlasKey}" not loaded for "${name}"`);
    return null;
  }
  const img = scene.add.image(x, y, def.atlasKey, def.frame);
  const [ox, oy] = opts.origin ?? [0.5, 1];
  img.setOrigin(ox, oy);
  if (opts.depth !== undefined) img.setDepth(opts.depth);
  if (opts.scale !== undefined) img.setScale(opts.scale);

  if (def.collides || opts.collideWith) {
    const TILE = 16;
    const fw = def.px.w * (opts.scale ?? 1);
    const fh = (opts.footprintTiles ?? 1) * TILE * (opts.scale ?? 1);
    // Origin is bottom-center, so the base sits at (x, y); center the band on it.
    const zone = scene.add.zone(x, y - fh / 2, fw, fh);
    scene.physics.add.existing(zone, true); // static body
    if (opts.collideWith) scene.physics.add.collider(opts.collideWith, zone);
    (img as Phaser.GameObjects.Image & { collisionZone?: Phaser.GameObjects.Zone }).collisionZone = zone;
  }
  return img;
}
