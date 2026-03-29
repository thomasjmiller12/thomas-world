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
    exitWidth: number;
    exitHeight: number;
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
      spawnX: 88, spawnY: 128,
      exitX: 88, exitY: 228,
      exitWidth: 160, exitHeight: 12,
    },
    returnX: 160, returnY: 184,
  },

  office: {
    id: 'office-door',
    building: 'office',
    sceneKey: SCENE_KEYS.OFFICE,
    town: { x: 432, y: 216, width: 32, height: 14 },
    interior: {
      spawnX: 152, spawnY: 96,
      exitX: 152, exitY: 196,
      exitWidth: 288, exitHeight: 12,
    },
    returnX: 432, returnY: 216,
  },

  workshop: {
    id: 'workshop-door',
    building: 'workshop',
    sceneKey: SCENE_KEYS.WORKSHOP,
    town: { x: 520, y: 216, width: 20, height: 14 },
    interior: {
      spawnX: 152, spawnY: 128,
      exitX: 80, exitY: 192,
      exitWidth: 48, exitHeight: 12,
    },
    returnX: 520, returnY: 216,
  },

  cafe: {
    id: 'cafe-door',
    building: 'cafe',
    sceneKey: SCENE_KEYS.CAFE,
    town: { x: 240, y: 376, width: 32, height: 14 },
    interior: {
      spawnX: 112, spawnY: 128,
      exitX: 112, exitY: 244,
      exitWidth: 128, exitHeight: 12,
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
