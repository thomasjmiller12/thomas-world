import type { LocationId } from '@town/contract';
import { SCENE_KEYS } from '@/lib/constants';

// Maps a contract LocationId to the Phaser scene that materializes it, plus a
// default world anchor where a resident/guest sprite is placed. `town` and
// `park` both live in the Town scene (park is a town region, design doc §2);
// interiors are their own scenes. This is the seam the canvas uses to decide
// whether an agent at location L should be rendered in the current scene, and
// where. Full multi-guest anchoring (NPCManager) lands in a later step; for now
// one anchor per location backs the single-resident canvas.

export interface LocationAnchor {
  sceneKey: string;
  // Default spawn/standing point for an agent at this location, in scene coords.
  anchor: { x: number; y: number };
}

export const LOCATION_ANCHORS: Record<LocationId, LocationAnchor> = {
  town: { sceneKey: SCENE_KEYS.TOWN, anchor: { x: 320, y: 350 } },
  // Park is a region of the town map (no dedicated interior scene).
  park: { sceneKey: SCENE_KEYS.TOWN, anchor: { x: 250, y: 380 } },
  office: { sceneKey: SCENE_KEYS.OFFICE, anchor: { x: 176, y: 64 } },
  library: { sceneKey: SCENE_KEYS.LIBRARY, anchor: { x: 96, y: 144 } },
  workshop: { sceneKey: SCENE_KEYS.WORKSHOP, anchor: { x: 128, y: 128 } },
  cafe: { sceneKey: SCENE_KEYS.CAFE, anchor: { x: 160, y: 144 } },
};

// Which contract LocationId a given scene materializes (inverse-ish of above;
// the Town scene reports `town`). Used to PATCH the visitor's location on a
// scene change and to scope in-world bubbles to the current scene.
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
