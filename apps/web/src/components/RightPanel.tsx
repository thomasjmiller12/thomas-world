import { useState, useRef, useCallback, useEffect } from 'react';
import { ChatWindow } from './ChatWindow';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId, ChatMessage } from '@/lib/types';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 256;

interface RightPanelProps {
  chatOpen: boolean;
  chatNpcId: ThomasId | null;
  chatNpcName: string;
  chatMessages: ChatMessage[];
  onChatSend: (message: string) => void;
  onChatClose: () => void;
  selectedNpcId: ThomasId | null;
  visible: boolean;
  onToggle: () => void;
}

export function RightPanel({
  chatOpen,
  chatNpcId,
  chatNpcName,
  chatMessages,
  onChatSend,
  onChatClose,
  selectedNpcId,
  visible,
  onToggle,
}: RightPanelProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left = larger panel (clientX decreases)
      const delta = startX.current - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
      setWidth(newWidth);
    };
    const onMouseUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  if (!visible) {
    return (
      <div className="h-full flex items-start pt-2">
        <button
          onClick={onToggle}
          className="text-[#c4b5a0]/30 hover:text-[#c4b5a0]/60 text-sm px-1 py-2 transition-colors"
          title="Show panel"
        >
          &lsaquo;
        </button>
      </div>
    );
  }

  const hasContent = (chatOpen && chatNpcId) || selectedNpcId;

  return (
    <div
      className="h-full flex pointer-events-auto"
      style={{ width: `${width}px`, minWidth: `${MIN_WIDTH}px`, maxWidth: `${MAX_WIDTH}px` }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="w-1 h-full cursor-col-resize bg-[#3d3654]/20 hover:bg-[#3d3654]/50 transition-colors shrink-0"
      />

      <div className="flex-1 h-full bg-[#1e1b2e] border-l border-[#3d3654]/40 flex flex-col overflow-hidden">
        {/* Collapse button row */}
        <div className="flex items-center justify-end px-1.5 py-1 border-b border-[#3d3654]/20">
          <button
            onClick={onToggle}
            className="text-[#c4b5a0]/30 hover:text-[#c4b5a0]/60 text-xs transition-colors"
            title="Hide panel"
          >
            &rsaquo;
          </button>
        </div>

        {chatOpen && chatNpcId ? (
          <div className="flex-1 overflow-hidden">
            <ChatWindow
              npcId={chatNpcId}
              npcName={chatNpcName}
              messages={chatMessages}
              onSend={onChatSend}
              onClose={onChatClose}
            />
          </div>
        ) : selectedNpcId ? (
          <NpcInfoView npcId={selectedNpcId} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[#c4b5a0]/25 text-xs text-center px-4">
              Select a resident to learn more
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function NpcInfoView({ npcId }: { npcId: ThomasId }) {
  const config = NPC_CONFIGS[npcId];
  const color = THOMAS_COLORS[npcId] || '#4A90D9';
  const statuses = useAgentStatuses();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#3d3654]/40" style={{ backgroundColor: color + '10' }}>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-xs font-bold" style={{ color }}>
            {config?.displayName}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-3">
          <p className="text-[9px] text-[#c4b5a0]/40 uppercase tracking-wider mb-1">Status</p>
          <p className="text-xs text-[#c4b5a0]/75">{statusLine(statuses[npcId])}</p>
        </div>
        <div>
          <p className="text-[9px] text-[#c4b5a0]/40 uppercase tracking-wider mb-1">About</p>
          <p className="text-xs text-[#c4b5a0]/60 leading-relaxed">{config?.aboutText}</p>
        </div>
      </div>

      <div className="px-3 py-2 border-t border-[#3d3654]/40">
        <p className="text-[9px] text-[#c4b5a0]/30 text-center">
          Walk nearby & press SPACE to chat
        </p>
      </div>
    </div>
  );
}
