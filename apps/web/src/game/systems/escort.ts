import type { LocationId } from '@town/contract';
import { LOCATION_ANCHORS, locationForScene, locationInScene } from '../data/location-anchors';
import { getDoorByBuilding, type DoorConfig } from '../data/door-configs';
import { pixelForZone } from '../data/zone-bounds';
import type { WorldEvents } from '../EventBus';

// Shared resolution helpers for an escort walk (Phase C.5, invite_visitor —
// "full auto-walk to destination"). The actual walking/transition glue lives
// per-scene (Town.ts / InteriorHelper.ts, since their transition machinery
// differs slightly) but both resolve the same way: where does `to` render,
// and what point should the player actually walk to once there.

export type EscortPayload = WorldEvents['visitor-escort'];

// The point to walk to once IN the target's scene — the same zone→pixel
// resolution agent.moved's targetZone gets (zone-bounds.ts), falling back to
// the location's resident anchor — never the bare door. "Bring me along"
// should land somewhere believable, not stranded at the threshold.
export function resolveEscortPoint(to: LocationId, targetZone: string | null): { x: number; y: number } {
  return (targetZone ? pixelForZone(targetZone) : undefined) ?? LOCATION_ANCHORS[to].resident;
}

export function sceneKeyFor(to: LocationId): string {
  return LOCATION_ANCHORS[to].sceneKey;
}

// The door config for entering `to`'s building from the town/park scene —
// undefined when `to` IS town/park (no door; it's already the outdoor map).
export function doorTo(to: LocationId): DoorConfig | undefined {
  const building = locationForScene(sceneKeyFor(to));
  return building ? getDoorByBuilding(building) : undefined;
}

export { locationInScene };
