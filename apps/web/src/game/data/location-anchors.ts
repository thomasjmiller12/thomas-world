import type { LocationId } from '@town/contract';
import { SCENE_KEYS } from '@/lib/constants';

// Per-location spawn/idle anchoring for the NPCManager (design doc §6.2). Each
// location declares:
//   - sceneKey:     which Phaser scene materializes it.
//   - resident:     the home agent's standing point (where its facet "lives").
//   - guests:       a ring of clear floor points where visiting agents stand —
//                   used when 2+ agents are co-located (e.g. a paced scene).
//   - door:         the point a sprite walks in from on arrival / out to on
//                   departure (interiors: the interior spawn tile by the door;
//                   town/park: a town-map edge/path point).
//
// Coordinates are derived from the existing maps: door-configs.ts (interior
// spawn/exit tiles), each interior scene's `setupInterior(... npcSpawn ...)`
// resident point, and npc-configs waypoints (town roaming paths). Interiors are
// small (20×15 ≈ 320×240px), so guest anchors are picked on clear floor near —
// but not on top of — the resident.
//
// `town` and `park` both live in the Town scene (park is a region of the town
// map, design doc §2); they get distinct anchor rings so a town-region agent
// reads as "in the park" vs "in the square".

export interface LocationAnchors {
  sceneKey: string;
  // The home agent's standing point.
  resident: { x: number; y: number };
  // Standing points for visiting (non-resident) agents, used in order.
  guests: { x: number; y: number }[];
  // Where sprites walk in from / out to on arrival / departure.
  door: { x: number; y: number };
}

export const LOCATION_ANCHORS: Record<LocationId, LocationAnchors> = {
  // Town square — Hobby's home region. Door is the player spawn / path mouth.
  town: {
    sceneKey: SCENE_KEYS.TOWN,
    resident: { x: 320, y: 350 },
    guests: [
      { x: 280, y: 360 },
      { x: 360, y: 360 },
      { x: 300, y: 410 },
      { x: 380, y: 330 },
    ],
    door: { x: 152, y: 456 },
  },
  // Park — a quieter corner of the same town map (Hobby's wander loop low edge).
  park: {
    sceneKey: SCENE_KEYS.TOWN,
    resident: { x: 250, y: 400 },
    guests: [
      { x: 300, y: 420 },
      { x: 210, y: 420 },
      { x: 360, y: 410 },
      { x: 270, y: 380 },
    ],
    door: { x: 152, y: 456 },
  },
  // Office — Career. Resident at the desk; guests fan out toward the entry.
  office: {
    sceneKey: SCENE_KEYS.OFFICE,
    resident: { x: 176, y: 64 },
    guests: [
      { x: 136, y: 96 },
      { x: 216, y: 96 },
      { x: 120, y: 64 },
      { x: 232, y: 64 },
    ],
    door: { x: 184, y: 80 },
  },
  // Library — Researcher. Resident at the reading nook.
  library: {
    sceneKey: SCENE_KEYS.LIBRARY,
    resident: { x: 96, y: 144 },
    guests: [
      { x: 144, y: 144 },
      { x: 96, y: 192 },
      { x: 144, y: 192 },
      { x: 64, y: 112 },
    ],
    door: { x: 272, y: 144 },
  },
  // Workshop — Builder. Resident at the bench.
  workshop: {
    sceneKey: SCENE_KEYS.WORKSHOP,
    resident: { x: 128, y: 128 },
    guests: [
      { x: 176, y: 128 },
      { x: 128, y: 168 },
      { x: 176, y: 168 },
      { x: 96, y: 96 },
    ],
    door: { x: 216, y: 104 },
  },
  // Cafe — Writer. Resident at the corner table.
  cafe: {
    sceneKey: SCENE_KEYS.CAFE,
    resident: { x: 160, y: 144 },
    guests: [
      { x: 112, y: 144 },
      { x: 160, y: 192 },
      { x: 112, y: 192 },
      { x: 128, y: 112 },
    ],
    door: { x: 88, y: 80 },
  },
};

// Which contract LocationId a given scene materializes. The Town scene reports
// `town` (park is a town region; agents whose location is `park` still render in
// the Town scene). Used to PATCH the visitor's location on a scene change and to
// scope in-world bubbles to the current scene.
export const SCENE_TO_LOCATION: Record<string, LocationId> = {
  [SCENE_KEYS.TOWN]: 'town',
  [SCENE_KEYS.OFFICE]: 'office',
  [SCENE_KEYS.LIBRARY]: 'library',
  [SCENE_KEYS.WORKSHOP]: 'workshop',
  [SCENE_KEYS.CAFE]: 'cafe',
};

export function locationForScene(sceneKey: string): LocationId | null {
  return SCENE_TO_LOCATION[sceneKey] ?? null;
}

// All LocationIds a given scene materializes (Town scene = town + park). Used by
// the NPCManager to decide which agents to render in the current scene.
const SCENE_LOCATIONS: Record<string, LocationId[]> = {
  [SCENE_KEYS.TOWN]: ['town', 'park'],
  [SCENE_KEYS.OFFICE]: ['office'],
  [SCENE_KEYS.LIBRARY]: ['library'],
  [SCENE_KEYS.WORKSHOP]: ['workshop'],
  [SCENE_KEYS.CAFE]: ['cafe'],
};

export function locationsForScene(sceneKey: string): LocationId[] {
  return SCENE_LOCATIONS[sceneKey] ?? [];
}

// True if an agent at `locationId` should be rendered in the scene `sceneKey`.
export function locationInScene(locationId: LocationId, sceneKey: string): boolean {
  return locationsForScene(sceneKey).includes(locationId);
}

// True if two contract locations materialize in the same Phaser scene (town &
// park share the Town scene). Used to scope bubbles/transcripts by current room.
export function sameScene(a: LocationId, b: LocationId): boolean {
  return LOCATION_ANCHORS[a].sceneKey === LOCATION_ANCHORS[b].sceneKey;
}
