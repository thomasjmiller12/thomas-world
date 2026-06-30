// Zone → pixel bounds (Phase C, space addressing). The server (engine/zones.ts)
// ships only a zone ID over the wire (agent.moved.targetZone) — never pixels;
// this is the frontend's OWN static table resolving that word to a rect, the
// same pattern LOCATION_ANCHORS already uses for per-location anchors.
//
// Hand-mirrored from `apps/world/src/engine/zones.ts` (single conceptual
// source, two hand-maintained copies — same convention as LOCATION_ANCHORS /
// INTERIOR_FIXTURE_POINTS already split frontend/backend). Coordinates were
// picked by rendering each map with render_map.py --grid and reading real
// fixture placements out of the scene source, not guessed. Keep both files in
// sync when a zone is added/moved.

export interface ZoneBounds {
  scene: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZONE_BOUNDS: Record<string, ZoneBounds> = {
  // town (+ park, same shared "Town" scene)
  "town.plaza-board": { scene: "Town", x: 376, y: 280, w: 40, h: 40 },
  "town.fountain-edge": { scene: "Town", x: 440, y: 290, w: 40, h: 40 },
  "town.news-corner": { scene: "Town", x: 447, y: 300, w: 40, h: 40 },
  "town.center": { scene: "Town", x: 300, y: 310, w: 40, h: 40 },
  "park.the-sign": { scene: "Town", x: 250, y: 340, w: 40, h: 40 },
  "park.bench-area": { scene: "Town", x: 88, y: 356, w: 40, h: 40 },
  "park.phone-box": { scene: "Town", x: 176, y: 320, w: 40, h: 40 },
  "park.center": { scene: "Town", x: 230, y: 360, w: 40, h: 40 },
  // office
  "office.outbox-nook": { scene: "Office", x: 207, y: 10, w: 40, h: 40 },
  "office.desk": { scene: "Office", x: 40, y: 100, w: 40, h: 40 },
  "office.center": { scene: "Office", x: 200, y: 110, w: 40, h: 40 },
  // library
  "library.stacks": { scene: "Library", x: 100, y: 40, w: 40, h: 40 },
  "library.reading-nook": { scene: "Library", x: 75, y: 140, w: 40, h: 40 },
  "library.desk": { scene: "Library", x: 90, y: 170, w: 40, h: 40 },
  "library.center": { scene: "Library", x: 120, y: 70, w: 40, h: 40 },
  // workshop
  "workshop.north-wall": { scene: "Workshop", x: 140, y: 0, w: 40, h: 40 },
  "workshop.bench-area": { scene: "Workshop", x: 32, y: 108, w: 40, h: 40 },
  "workshop.monitor-corner": { scene: "Workshop", x: 117, y: 35, w: 40, h: 40 },
  "workshop.center": { scene: "Workshop", x: 140, y: 80, w: 40, h: 40 },
  // cafe
  "cafe.press-corner": { scene: "Cafe", x: 115, y: 0, w: 40, h: 40 },
  "cafe.counter": { scene: "Cafe", x: 37, y: 77, w: 40, h: 40 },
  "cafe.tables": { scene: "Cafe", x: 135, y: 100, w: 40, h: 40 },
  "cafe.center": { scene: "Cafe", x: 100, y: 104, w: 40, h: 40 },
};

// The resolver's target point is a zone rect's BOTTOM-CENTER (matches the
// asset pipeline's [0.5,1] sprite origin convention — see the Embodiment doc's
// placement invariant) — for a fixture-adjacent zone, that's the fixture's own
// base point. Returns undefined for an unknown zone id (the caller falls back
// to the location anchor — "unknown ref degrades to room-center, never errors").
export function pixelForZone(zoneId: string): { x: number; y: number } | undefined {
  const b = ZONE_BOUNDS[zoneId];
  if (!b) return undefined;
  return { x: b.x + b.w / 2, y: b.y + b.h };
}
