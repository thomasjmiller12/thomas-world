export type ThomasId = 'career' | 'researcher' | 'builder' | 'writer' | 'hobby';

export interface NPCConfig {
  id: ThomasId;
  displayName: string;
  sprite: string;
  homeBuilding: string;
  homePosition: { x: number; y: number };
  color: string;
  greeting: string;
  waypoints: { x: number; y: number }[];
  stubbedResponses: string[];
  status: string;
  aboutText: string;
}

export interface SimulatedAction {
  type: 'move' | 'enter_building' | 'exit_building' | 'say' | 'think' | 'work' | 'interact_agent' | 'idle';
  target?: { x: number; y: number };
  building?: string;
  message?: string;
  thought?: string;
  description?: string;
  targetAgent?: ThomasId;
  audience?: 'public' | string;
  duration?: number;
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
