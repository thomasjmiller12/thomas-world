import type { ThomasId } from '@/lib/types';
import { THOMAS_COLORS } from '@/lib/constants';

interface ThoughtBubbleProps {
  npcId: ThomasId;
  text: string;
  screenX: number;
  screenY: number;
}

export function ThoughtBubble({ npcId, text, screenX, screenY }: ThoughtBubbleProps) {
  const color = THOMAS_COLORS[npcId] || '#4A90D9';

  if (screenX === 0 && screenY === 0) return null;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${screenX}px`,
        top: `${screenY - 60}px`,
        transform: 'translateX(-50%)',
        zIndex: 30,
        animation: 'fadeInUp 0.3s ease-out',
      }}
    >
      <div className="bg-black/80 border rounded-lg px-3 py-2 max-w-48 relative" style={{ borderColor: color + '60' }}>
        <p className="text-gray-200 text-[10px] leading-relaxed">{text}</p>
        <div
          className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-0 h-0"
          style={{
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: `6px solid ${color}60`,
          }}
        />
      </div>
    </div>
  );
}
