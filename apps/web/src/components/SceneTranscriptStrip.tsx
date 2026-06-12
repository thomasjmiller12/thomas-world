import { useEffect, useRef } from 'react';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';

export interface TranscriptLine {
  id: string;
  npcId: ThomasId;
  text: string;
}

interface SceneTranscriptStripProps {
  participants: ThomasId[];
  lines: TranscriptLine[];
  onJoin: () => void;
}

// Tier-1.5 listen-in surface (design doc §1, §3.3a): a thin read-only strip at
// the bottom of the town shown while a live agent↔agent scene is happening in
// the current location. Auto-follows the transcript and offers a ⊕ "join in"
// affordance wired to WorldClient.joinConversation. Skeleton only — full styling
// (design tokens, animations) lands in build step F.
export function SceneTranscriptStrip({ participants, lines, onJoin }: SceneTranscriptStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-follow the latest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const names = participants
    .map((id) => NPC_CONFIGS[id]?.displayName.replace('Thomas', '').trim() || id)
    .join(' & ');

  return (
    <div
      className="absolute bottom-0 left-0 right-0 pointer-events-auto"
      style={{ zIndex: 32 }}
    >
      <div className="bg-[#1e1b2e]/95 border-t border-[#3d3654]/60 px-3 py-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-mono uppercase tracking-widest text-[#c4b5a0]/60">
            Live · {names}
          </span>
          <button
            onClick={onJoin}
            className="text-[10px] text-emerald-300/90 hover:text-emerald-200 border border-emerald-400/40 rounded px-2 py-0.5"
            title="Jump into this conversation"
          >
            &#8853; join in
          </button>
        </div>
        <div ref={scrollRef} className="max-h-16 overflow-y-auto space-y-0.5">
          {lines.map((line) => (
            <p key={line.id} className="text-[11px] leading-snug text-[#c4b5a0]/85">
              <span
                className="font-bold"
                style={{ color: THOMAS_COLORS[line.npcId] || '#c4b5a0' }}
              >
                {NPC_CONFIGS[line.npcId]?.displayName.replace('Thomas', '').trim() || line.npcId}:
              </span>{' '}
              {line.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
