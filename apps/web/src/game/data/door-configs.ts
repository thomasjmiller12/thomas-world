import { SCENE_KEYS } from '@/lib/constants';

export interface DoorConfig {
  id: string;
  building: string;
  sceneKey: string;
  town: { x: number; y: number; width: number; height: number };
  interior: {
    spawnX: number;
    spawnY: number;
    exitX: number;
    exitY: number;
  };
  returnX: number;
  returnY: number;
}

export const DOOR_CONFIGS: Record<string, DoorConfig> = {
  library: {
    id: 'library-door',
    building: 'library',
    sceneKey: SCENE_KEYS.LIBRARY,
    town: { x: 160, y: 184, width: 32, height: 14 },
    interior: {
      spawnX: 272, spawnY: 144,
      exitX: 296, exitY: 144,
    },
    returnX: 160, returnY: 184,
  },

  office: {
    id: 'office-door',
    building: 'office',
    sceneKey: SCENE_KEYS.OFFICE,
    town: { x: 432, y: 216, width: 32, height: 14 },
    interior: {
      spawnX: 184, spawnY: 80,
      exitX: 184, exitY: 56,
    },
    returnX: 432, returnY: 216,
  },

  workshop: {
    id: 'workshop-door',
    building: 'workshop',
    sceneKey: SCENE_KEYS.WORKSHOP,
    town: { x: 520, y: 216, width: 20, height: 14 },
    interior: {
      spawnX: 216, spawnY: 104,
      exitX: 216, exitY: 88,
    },
    returnX: 520, returnY: 216,
  },

  cafe: {
    id: 'cafe-door',
    building: 'cafe',
    sceneKey: SCENE_KEYS.CAFE,
    town: { x: 240, y: 376, width: 32, height: 14 },
    interior: {
      spawnX: 88, spawnY: 80,
      exitX: 88, exitY: 56,
    },
    returnX: 240, returnY: 376,
  },
};

export function getDoorByBuilding(building: string): DoorConfig | undefined {
  return DOOR_CONFIGS[building];
}

export function getDoorByScene(sceneKey: string): DoorConfig | undefined {
  return Object.values(DOOR_CONFIGS).find(d => d.sceneKey === sceneKey);
}
