import type { ThomasId } from '@/lib/types';
import type { AgentId, LocationId } from '@town/contract';

// A rendered message in the live transcript. Agent turns may still be streaming
// (`streaming: true`) — the bubble grows as deltas land; on `done` it freezes.
// `memory` carries the restrained recall label when a memory_recalled frame
// arrived during the turn. System lines (e.g. "Builder joined the conversation")
// use `kind: 'system'`.
export interface ChatLine {
  id: string;
  kind: 'agent' | 'visitor' | 'system';
  // For agent/visitor lines. System lines leave this undefined.
  speaker?: ThomasId | 'visitor';
  text: string;
  streaming?: boolean;
  memory?: string | null;
}

// What the container is showing. Tier 1 = diegetic dialog; Tier 2 = docked
// panel. `busy` = the 409 actionable-alternatives surface (still diegetic).
export type ChatTier = 'diegetic' | 'docked';

// The agent the visitor walked up to / opened. Carries the live activity line
// captured from the snapshot at open time (the two-step gate's free first step
// — name + activity with zero network).
export interface ChatTarget {
  npcId: ThomasId;
  npcName: string;
  activity: string;
}

// When a chat open fails because the agent is engaged, the container renders
// actionable alternatives (design doc §1 busy path). The kind decides which:
// 'scene' → [listen in] (travel + transcript strip); 'chat' → profile rail.
export interface BusyAlternative {
  kind: 'scene' | 'chat';
  // For scene alternatives: where to travel + the conversation to listen in on.
  location?: LocationId;
  conversationId?: string;
  participants?: AgentId[];
}
