// The semantic-zone registry (MUD embodiment foundation). A zone is a NAMED
// sub-region of a location the agent addresses in WORDS ("workshop.north-wall"),
// never pixels — the agent's spatial vocabulary. Zone → renderer coordinates is
// a frontend/validation concern; the server stores only the zone id on
// world_objects.zone and validates it against this static registry.
//
// Static (not a DB row) so it's a single shared source both the seed and any
// future validation/read paths read from. Seeded into locations.zones for the
// read API. ~3-6 zones per location.

import type { LocationId, SemanticZone } from "@town/contract";

// Bounds (Phase C, space addressing) were picked offline by rendering each
// map with render_map.py --grid and reading real fixture coordinates straight
// out of the scene source (Town.ts / Office.ts / Library.ts / Workshop.ts /
// Cafe.ts placeTownObject calls + INTERIOR_FIXTURE_POINTS) — not guessed.
// {x,y,w,h} is a rect; the resolver's target is its BOTTOM-CENTER, so a
// fixture-adjacent zone's rect is sized/positioned so that point lands right
// on the fixture. `scene` is the Phaser scene key that renders this location
// ("Town" hosts both town + park — they're regions of one map).
export const ZONES: Record<LocationId, SemanticZone[]> = {
  town: [
    { id: "town.plaza-board", label: "by the notice board", bounds: { scene: "Town", x: 376, y: 280, w: 40, h: 40 } },
    { id: "town.fountain-edge", label: "at the fountain's edge", bounds: { scene: "Town", x: 440, y: 290, w: 40, h: 40 } },
    { id: "town.news-corner", label: "by the news stand", bounds: { scene: "Town", x: 447, y: 300, w: 40, h: 40 } },
    { id: "town.center", label: "in the middle of the square", bounds: { scene: "Town", x: 300, y: 310, w: 40, h: 40 } },
  ],
  office: [
    { id: "office.outbox-nook", label: "by the outbox", bounds: { scene: "Office", x: 207, y: 10, w: 40, h: 40 } },
    { id: "office.desk", label: "at the desk", bounds: { scene: "Office", x: 40, y: 100, w: 40, h: 40 } },
    { id: "office.center", label: "in the middle of the office", bounds: { scene: "Office", x: 200, y: 110, w: 40, h: 40 } },
  ],
  library: [
    { id: "library.stacks", label: "among the stacks", bounds: { scene: "Library", x: 100, y: 40, w: 40, h: 40 } },
    { id: "library.reading-nook", label: "in the reading nook", bounds: { scene: "Library", x: 75, y: 140, w: 40, h: 40 } },
    { id: "library.desk", label: "at the reading desk", bounds: { scene: "Library", x: 90, y: 170, w: 40, h: 40 } },
    { id: "library.center", label: "in the middle of the library", bounds: { scene: "Library", x: 120, y: 70, w: 40, h: 40 } },
  ],
  workshop: [
    { id: "workshop.north-wall", label: "along the north wall", bounds: { scene: "Workshop", x: 140, y: 0, w: 40, h: 40 } },
    { id: "workshop.bench-area", label: "at the workbench", bounds: { scene: "Workshop", x: 32, y: 108, w: 40, h: 40 } },
    { id: "workshop.monitor-corner", label: "by the monitor", bounds: { scene: "Workshop", x: 117, y: 35, w: 40, h: 40 } },
    { id: "workshop.center", label: "in the middle of the workshop", bounds: { scene: "Workshop", x: 140, y: 80, w: 40, h: 40 } },
  ],
  cafe: [
    { id: "cafe.press-corner", label: "by the press", bounds: { scene: "Cafe", x: 115, y: 0, w: 40, h: 40 } },
    { id: "cafe.counter", label: "at the counter", bounds: { scene: "Cafe", x: 37, y: 77, w: 40, h: 40 } },
    { id: "cafe.tables", label: "among the tables", bounds: { scene: "Cafe", x: 135, y: 100, w: 40, h: 40 } },
    { id: "cafe.center", label: "in the middle of the cafe", bounds: { scene: "Cafe", x: 100, y: 104, w: 40, h: 40 } },
  ],
  park: [
    { id: "park.the-sign", label: "by the painted sign", bounds: { scene: "Town", x: 250, y: 340, w: 40, h: 40 } },
    { id: "park.bench-area", label: "by the bench", bounds: { scene: "Town", x: 88, y: 356, w: 40, h: 40 } },
    { id: "park.phone-box", label: "by the telephone box", bounds: { scene: "Town", x: 176, y: 320, w: 40, h: 40 } },
    { id: "park.center", label: "out on the grass", bounds: { scene: "Town", x: 230, y: 360, w: 40, h: 40 } },
  ],
};

// Coarse location type, seeded onto locations.kind.
export const LOCATION_KIND: Record<LocationId, string> = {
  town: "outdoor",
  office: "interior",
  library: "interior",
  workshop: "interior",
  cafe: "interior",
  park: "outdoor",
};

export function zonesForLocation(locationId: LocationId): SemanticZone[] {
  return ZONES[locationId] ?? [];
}

// Every zone across every location (the read-API registry).
export function allZones(): SemanticZone[] {
  return Object.values(ZONES).flat();
}

// The fallback zone for a location — its "center". Used when no specific zone
// is known for a seeded fixture or an agent omits one.
export function defaultZone(locationId: LocationId): string {
  return `${locationId}.center`;
}

// True if `zoneId` is a real zone in `locationId` (cheap string check — the
// validation a control verb runs before writing a zone onto a world_object).
export function zoneExists(zoneId: string, locationId?: LocationId): boolean {
  if (locationId) {
    return zonesForLocation(locationId).some((z) => z.id === zoneId);
  }
  return Object.values(ZONES).some((zs) => zs.some((z) => z.id === zoneId));
}
