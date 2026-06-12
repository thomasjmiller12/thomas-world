export const TILE_SIZE = 16;
export const MAP_WIDTH_TILES = 40;
export const MAP_HEIGHT_TILES = 30;
export const MAP_WIDTH = MAP_WIDTH_TILES * TILE_SIZE;
export const MAP_HEIGHT = MAP_HEIGHT_TILES * TILE_SIZE;

export const GAME_WIDTH = 432;
export const GAME_HEIGHT = 288;
export const CAMERA_ZOOM = 1;

export const PLAYER_SPEED = 60;
export const NPC_SPEED = 20;
export const INTERACTION_RANGE = 24;

export const SCENE_KEYS = {
  BOOT: 'Boot',
  PRELOADER: 'Preloader',
  TOWN: 'Town',
  OFFICE: 'Office',
  LIBRARY: 'Library',
  WORKSHOP: 'Workshop',
  CAFE: 'Cafe',
} as const;

export const THOMAS_COLORS: Record<string, string> = {
  career: '#4A90D9',
  researcher: '#9B59B6',
  builder: '#E67E22',
  writer: '#27AE60',
  hobby: '#E74C3C',
};
