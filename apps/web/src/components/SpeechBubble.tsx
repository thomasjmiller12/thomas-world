import type { ThomasId } from '@/lib/types';
import { THOMAS_COLORS } from '@/lib/constants';

interface SpeechBubbleProps {
  npcId: ThomasId;
  text: string;
  screenX: number;
  screenY: number;
  // A scene turn (agent↔agent) reads slightly differently from ambient speech.
  scene?: boolean;
}

// Tier-0 ambient speech bubble (design doc §1): a React overlay component
// positioned via the `npc-screen-position` stream — NOT a Phaser graphic, so it
// can carry design-system typography and truncate gracefully. Max-width ~240px,
// clamped to ~3 lines with an ellipsis; the full text always lands in the feed
// + transcript strip (agent.spoke can be 600 chars; a pixel bubble can't).
export function SpeechBubble({ npcId, text, screenX, screenY, scene }: SpeechBubbleProps) {
  const color = THOMAS_COLORS[npcId] || '#4A90D9';

  if (screenX === 0 && screenY === 0) return null;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${screenX}px`,
        top: `${screenY - 52}px`,
        transform: 'translateX(-50%)',
        zIndex: 31,
        maxWidth: 240,
        animation: 'fadeInUp 0.25s ease-out',
      }}
    >
      <div
        className="relative rounded-lg px-3 py-1.5"
        style={{
          background: scene ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.92)',
          border: `1px solid ${color}80`,
          boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
        }}
      >
        <p
          className="text-[#2B2620] text-[11px] leading-snug"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {text}
        </p>
        <div
          className="absolute -bottom-[6px] left-1/2 -translate-x-1/2 w-0 h-0"
          style={{
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: `6px solid ${color}80`,
          }}
        />
      </div>
    </div>
  );
}
