import type { LocationId } from '@town/contract';
import { LOCATION_ANCHORS, locationInScene, locationForScene } from './location-anchors';
import { getDoorByBuilding, type DoorConfig } from './door-configs';
import { SCENE_KEYS } from '@/lib/constants';

// Show-in-town resolution (design doc §6.3): turning a feed/roster location into
// a camera move. Pure (no Phaser), so the decision is unit-testable; the scene
// performs the actual pan / transition with the returned plan.
//
//   - location is in the CURRENT scene  → pan the camera to the anchor.
//   - location is a DIFFERENT scene     → door-path transition to that scene,
//                                          then center on the anchor on arrival.
//   - null/unknown                      → no affordance (caller drops it).

export type TravelPlan =
  | { kind: 'pan'; anchor: { x: number; y: number } }
  | {
      // Transition to an interior: enter through its town-side door (or, when
      // already inside another interior, route via the town first by exiting).
      kind: 'enter-interior';
      door: DoorConfig;
      anchor: { x: number; y: number };
    }
  | {
      // Transition back to the town/park region (the location lives in Town).
      kind: 'to-town';
      anchor: { x: number; y: number };
    };

// The standing point to center on for a location — the resident anchor by
// default (a believable "here's where this happens" spot). When the caller
// knows a specific agent's anchor it can override via the event's `anchor`.
export function defaultAnchorFor(locationId: LocationId): { x: number; y: number } {
  return LOCATION_ANCHORS[locationId].resident;
}

// Resolve a travel request from the current scene to a target location.
// `anchor` overrides the default standing point (e.g. the targeted agent's slot).
export function resolveTravel(
  currentSceneKey: string,
  locationId: LocationId,
  anchor?: { x: number; y: number }
): TravelPlan {
  const target = anchor ?? defaultAnchorFor(locationId);

  // Same scene → just pan.
  if (locationInScene(locationId, currentSceneKey)) {
    return { kind: 'pan', anchor: target };
  }

  const targetSceneKey = LOCATION_ANCHORS[locationId].sceneKey;

  // Target is the town/park region.
  if (targetSceneKey === SCENE_KEYS.TOWN) {
    return { kind: 'to-town', anchor: target };
  }

  // Target is an interior — enter through its door. `locationForScene` gives the
  // building key the door config is keyed by.
  const building = locationForScene(targetSceneKey);
  const door = building ? getDoorByBuilding(building) : undefined;
  if (door) {
    return { kind: 'enter-interior', door, anchor: target };
  }

  // Fallback: route to town (shouldn't happen given the scene map).
  return { kind: 'to-town', anchor: defaultAnchorFor('town') };
}
