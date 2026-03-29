import { useState } from 'react';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import type { ThomasId, NPCConfig } from '@/lib/types';

const BUILDING_LABELS: Record<string, string> = {
  office: 'Office',
  library: 'Library',
  workshop: 'Workshop',
  cafe: 'Cafe',
  park: 'Town',
};

// Sprite sheets are 64x96 with 16x24 frames (4 cols x 4 rows)
// Frame 0 (top-left) is the front-facing idle pose
function SpriteIcon({ sprite }: { sprite: string }) {
  return (
    <div
      className="shrink-0"
      style={{
        width: 16,
        height: 24,
        backgroundImage: `url(/assets/sprites/${sprite}.png)`,
        backgroundPosition: '0 0',
        backgroundSize: '64px 96px',
        imageRendering: 'pixelated',
        transform: 'scale(1.5)',
        transformOrigin: 'center',
      }}
    />
  );
}

interface AgentRosterProps {
  proximityNpcId: ThomasId | null;
  chatNpcId: ThomasId | null;
  selectedNpcId: ThomasId | null;
  onNpcClick: (id: ThomasId) => void;
}

export function AgentRoster({ proximityNpcId, chatNpcId, selectedNpcId, onNpcClick }: AgentRosterProps) {
  const [collapsed, setCollapsed] = useState(false);
  const npcs = Object.values(NPC_CONFIGS);

  if (collapsed) {
    return (
      <div className="w-10 h-full bg-[#1e1b2e] border-r border-[#3d3654]/40 flex flex-col items-center pt-2 gap-2">
        <button
          onClick={() => setCollapsed(false)}
          className="text-[#c4b5a0]/60 hover:text-[#c4b5a0] text-sm mb-1"
          title="Show residents"
        >
          &rsaquo;
        </button>
        {npcs.map(config => (
          <button
            key={config.id}
            onClick={() => { setCollapsed(false); onNpcClick(config.id); }}
            className="relative group"
            title={config.displayName}
          >
            <div
              className="w-2 h-2 rounded-full transition-all"
              style={{
                backgroundColor: config.color,
                boxShadow: (proximityNpcId === config.id || chatNpcId === config.id)
                  ? `0 0 6px ${config.color}80`
                  : 'none',
              }}
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="w-48 h-full bg-[#1e1b2e] border-r border-[#3d3654]/40 flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-[#3d3654]/40 flex items-center justify-between">
        <p className="text-[#c4b5a0]/50 text-[9px] font-mono uppercase tracking-widest">Residents</p>
        <button
          onClick={() => setCollapsed(true)}
          className="text-[#c4b5a0]/40 hover:text-[#c4b5a0] text-xs"
          title="Collapse"
        >
          &lsaquo;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {npcs.map(config => (
          <RosterEntry
            key={config.id}
            config={config}
            isNear={proximityNpcId === config.id}
            isChatting={chatNpcId === config.id}
            isSelected={selectedNpcId === config.id}
            onClick={() => onNpcClick(config.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RosterEntry({ config, isNear, isChatting, isSelected, onClick }: {
  config: NPCConfig;
  isNear: boolean;
  isChatting: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  const location = BUILDING_LABELS[config.homeBuilding] || config.homeBuilding;

  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left px-3 py-2 border-b border-[#3d3654]/20 transition-colors
        hover:bg-[#2a2540]
        ${isChatting ? 'bg-[#2a2540]' : ''}
        ${isSelected && !isChatting ? 'bg-[#252040]' : ''}
      `}
    >
      <div className="flex items-center gap-2">
        <SpriteIcon sprite={config.sprite} />
        <div className="min-w-0 flex-1 ml-1">
          <div className="flex items-center gap-1.5">
            <span
              className="text-[11px] font-bold truncate"
              style={{ color: config.color }}
            >
              {config.displayName.replace('Thomas', '').trim()}
            </span>
            {isNear && (
              <span className="text-[8px] text-emerald-400/80">~</span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[8px] text-[#c4b5a0]/30 bg-[#c4b5a0]/5 px-1 py-px rounded">
              {location}
            </span>
          </div>
        </div>
      </div>
      <p className="text-[9px] text-[#c4b5a0]/35 mt-1 leading-snug line-clamp-1 pl-1">
        {config.status}
      </p>
    </button>
  );
}
