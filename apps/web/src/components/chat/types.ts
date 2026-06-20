import type { ThomasId } from '@/lib/types';
import type { ShareCard } from '@town/contract';

// A rendered line in the live transcript. Agent turns may still be streaming
// (`streaming: true`) — the bubble grows as deltas land; on `done` it freezes.
// `memory` carries the restrained recall label when a memory_recalled frame
// arrived during the turn.
//
// Line kinds (M2.1):
//   agent   — a streamed agent reply bubble.
//   visitor — the visitor's own line.
//   system  — a centered system line (e.g. an error / engaged notice).
//   action  — the agent acted mid-chat ("*walks to the workbench*"), centered.
//   ended   — the agent ended the chat ("Builder headed back to work."), the
//             goodbye system line that replaces the input row with a close button.
export interface ChatLine {
  id: string;
  kind: 'agent' | 'visitor' | 'system' | 'action' | 'ended' | 'share-card';
  // For agent/visitor/action/ended/share-card lines. Pure system lines leave this undefined.
  speaker?: ThomasId | 'visitor';
  text: string;
  streaming?: boolean;
  memory?: string | null;
  // A share-card line carries the card (M2.2 — Part 4).
  card?: ShareCard;
}

// The agent the visitor is chatting with. Carries the live activity line
// captured from the snapshot at open time (refreshed live from useAgentStatuses
// while the panel is open).
export interface ChatTarget {
  npcId: ThomasId;
  npcName: string;
  activity: string;
}
