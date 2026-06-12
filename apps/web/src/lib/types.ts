export type ThomasId = 'career' | 'researcher' | 'builder' | 'writer' | 'hobby';

// Display + canvas data the renderer needs. Live behavior (status, activity,
// engagement, chat replies) now comes from the world server via WorldClient —
// the old stale `greeting` / `status` / `stubbedResponses` fields are gone. The
// `aboutText` bio stays (it's static, not state).
export interface NPCConfig {
  id: ThomasId;
  displayName: string;
  sprite: string;
  homeBuilding: string;
  homePosition: { x: number; y: number };
  color: string;
  waypoints: { x: number; y: number }[];
  aboutText: string;
}

export interface ChatMessage {
  sender: 'visitor' | ThomasId;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface ThoughtBubbleData {
  id: string;
  npcId: ThomasId;
  text: string;
  screenX: number;
  screenY: number;
}

export interface DialogData {
  text: string;
  title?: string;
}
