// Lightweight 4-directional A* over a scene's collision tilemap layer, so NPC
// walks (door arrivals, departures, guest-anchor moves) follow real routes
// instead of straight lines into walls. No dependency, no diagonal moves (16px
// pixel-art reads better on cardinal steps, and diagonals corner-clip).
//
// The grid is derived from the SAME TilemapLayer the scenes use for physics
// colliders, so "walkable here" agrees with where a body can actually stand.
// Start/goal tiles that are blocked (an anchor on a prop, an NPC flush against
// a wall) snap to the nearest walkable tile within a small radius. Returns
// world-coordinate waypoints at tile centers (final point = the exact target
// when its tile is walkable); null when no route exists or the search is
// degenerate — callers fall back to the straight-line walk, where the NPC's
// stall guard still protects against eternal wall-bumping.

interface Point {
  x: number;
  y: number;
}

const MAX_EXPLORED = 4000; // hard cap; town maps are ~30x30 tiles, this is generous
const SNAP_RADIUS = 6; // tiles to search when start/goal is blocked (anchor/door
// on a collision tile). Wider than the original 4-ring so a goal a few tiles
// deep into a prop cluster still snaps to a reachable walkable tile and gets a
// real A* route, instead of returning null → a straight-line wall-run.

export function findPath(
  layer: Phaser.Tilemaps.TilemapLayer | null,
  fromWorld: Point,
  toWorld: Point
): Point[] | null {
  if (!layer) return null;
  const data = layer.layer;
  const width = data.width;
  const height = data.height;
  const tw = data.tileWidth;
  const th = data.tileHeight;

  const toTile = (p: Point) => ({
    tx: Math.floor((p.x - layer.x) / tw),
    ty: Math.floor((p.y - layer.y) / th),
  });
  const toWorldCenter = (tx: number, ty: number): Point => ({
    x: layer.x + tx * tw + tw / 2,
    y: layer.y + ty * th + th / 2,
  });
  const inBounds = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < width && ty < height;
  const walkable = (tx: number, ty: number): boolean => {
    if (!inBounds(tx, ty)) return false;
    const t = layer.getTileAt(tx, ty);
    return !t || !t.collides;
  };

  // Snap a blocked endpoint to the nearest walkable tile (ring search).
  const snap = (tx: number, ty: number): { tx: number; ty: number } | null => {
    if (walkable(tx, ty)) return { tx, ty };
    for (let r = 1; r <= SNAP_RADIUS; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const dy of dx === -r || dx === r ? rangeInclusive(-r, r) : [-r, r]) {
          if (walkable(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
        }
      }
    }
    return null;
  };

  const start = snap(toTile(fromWorld).tx, toTile(fromWorld).ty);
  const goal = snap(toTile(toWorld).tx, toTile(toWorld).ty);
  if (!start || !goal) return null;
  if (start.tx === goal.tx && start.ty === goal.ty) return [toWorld];

  // A* with a plain-array open list — grids this small don't need a heap.
  const key = (tx: number, ty: number) => ty * width + tx;
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const h = (tx: number, ty: number) => Math.abs(tx - goal.tx) + Math.abs(ty - goal.ty);

  interface Node {
    tx: number;
    ty: number;
    f: number;
  }
  const open: Node[] = [{ tx: start.tx, ty: start.ty, f: h(start.tx, start.ty) }];
  gScore.set(key(start.tx, start.ty), 0);
  let explored = 0;

  while (open.length > 0 && explored < MAX_EXPLORED) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const cur = open.splice(bestIdx, 1)[0];
    const ck = key(cur.tx, cur.ty);
    if (closed.has(ck)) continue;
    closed.add(ck);
    explored++;

    if (cur.tx === goal.tx && cur.ty === goal.ty) {
      // Reconstruct tile path → world centers, then drop collinear midpoints.
      const tiles: { tx: number; ty: number }[] = [];
      let k: number | undefined = ck;
      while (k !== undefined) {
        tiles.push({ tx: k % width, ty: Math.floor(k / width) });
        k = cameFrom.get(k);
      }
      tiles.reverse();
      const points = simplify(tiles).map((t) => toWorldCenter(t.tx, t.ty));
      // Land on the exact requested point when its tile is the goal tile.
      const reqTile = toTile(toWorld);
      if (reqTile.tx === goal.tx && reqTile.ty === goal.ty) {
        points[points.length - 1] = { x: toWorld.x, y: toWorld.y };
      }
      // Drop the leading point when we're already standing on it.
      if (points.length > 1) {
        const d0 = Math.hypot(points[0].x - fromWorld.x, points[0].y - fromWorld.y);
        if (d0 < tw / 2) points.shift();
      }
      return points;
    }

    const g = gScore.get(ck) ?? Infinity;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cur.tx + dx;
      const ny = cur.ty + dy;
      if (!walkable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = g + 1;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        cameFrom.set(nk, ck);
        open.push({ tx: nx, ty: ny, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function rangeInclusive(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

// Remove midpoints on straight segments so the sprite walks long legs instead
// of twitching tile-to-tile.
function simplify(tiles: { tx: number; ty: number }[]): { tx: number; ty: number }[] {
  if (tiles.length <= 2) return tiles;
  const out = [tiles[0]];
  for (let i = 1; i < tiles.length - 1; i++) {
    const a = out[out.length - 1];
    const b = tiles[i];
    const c = tiles[i + 1];
    const colinear = (b.tx - a.tx) * (c.ty - b.ty) === (b.ty - a.ty) * (c.tx - b.tx);
    if (!colinear) out.push(b);
  }
  out.push(tiles[tiles.length - 1]);
  return out;
}
