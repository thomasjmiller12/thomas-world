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

export const ZONES: Record<LocationId, SemanticZone[]> = {
  town: [
    { id: "town.plaza-board", label: "by the notice board" },
    { id: "town.fountain-edge", label: "at the fountain's edge" },
    { id: "town.news-corner", label: "by the news stand" },
    { id: "town.center", label: "in the middle of the square" },
  ],
  office: [
    { id: "office.outbox-nook", label: "by the outbox" },
    { id: "office.desk", label: "at the desk" },
    { id: "office.center", label: "in the middle of the office" },
  ],
  library: [
    { id: "library.stacks", label: "among the stacks" },
    { id: "library.reading-nook", label: "in the reading nook" },
    { id: "library.desk", label: "at the reading desk" },
    { id: "library.center", label: "in the middle of the library" },
  ],
  workshop: [
    { id: "workshop.north-wall", label: "along the north wall" },
    { id: "workshop.bench-area", label: "at the workbench" },
    { id: "workshop.monitor-corner", label: "by the monitor" },
    { id: "workshop.center", label: "in the middle of the workshop" },
  ],
  cafe: [
    { id: "cafe.press-corner", label: "by the press" },
    { id: "cafe.counter", label: "at the counter" },
    { id: "cafe.tables", label: "among the tables" },
    { id: "cafe.center", label: "in the middle of the cafe" },
  ],
  park: [
    { id: "park.the-sign", label: "by the painted sign" },
    { id: "park.bench-area", label: "by the bench" },
    { id: "park.phone-box", label: "by the telephone box" },
    { id: "park.center", label: "out on the grass" },
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
