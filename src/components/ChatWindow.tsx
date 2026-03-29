import { useState, useRef, useEffect } from 'react';
import type { ThomasId, ChatMessage } from '@/lib/types';
import { THOMAS_COLORS } from '@/lib/constants';

interface ChatWindowProps {
  npcId: ThomasId;
  npcName: string;
  messages: ChatMessage[];
  onSend: (message: string) => void;
  onClose: () => void;
}

export function ChatWindow({ npcId, npcName, messages, onSend, onClose }: ChatWindowProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const npcColor = THOMAS_COLORS[npcId] || '#4A90D9';

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    onSend(msg);
    setInput('');
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#1e1b2e] overflow-hidden">
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-[#3d3654]/40"
        style={{ backgroundColor: npcColor + '15' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: npcColor }} />
          <span className="text-xs font-bold" style={{ color: npcColor }}>{npcName}</span>
        </div>
        <button onClick={onClose} className="text-[#c4b5a0]/40 hover:text-[#c4b5a0] text-sm leading-none">x</button>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.sender === 'visitor' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[90%] px-2.5 py-1.5 rounded-lg text-[11px] leading-relaxed ${
                msg.sender === 'visitor' ? 'bg-[#4A90D9]/20 text-[#c4b5a0]' : 'text-[#c4b5a0]'
              }`}
              style={msg.sender !== 'visitor' ? { backgroundColor: npcColor + '15' } : {}}
            >
              <span className="font-bold text-[9px] block mb-0.5" style={{ color: msg.sender === 'visitor' ? '#7ab3e8' : npcColor }}>
                {msg.senderName}
              </span>
              <span>{msg.text}</span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-[#3d3654]/40 p-2 flex gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Say something..."
          className="flex-1 bg-[#c4b5a0]/5 text-[#c4b5a0] text-[11px] px-2.5 py-1.5 rounded border border-[#3d3654]/30 focus:outline-none focus:border-[#3d3654]/60 placeholder-[#c4b5a0]/20"
        />
        <button
          onClick={handleSend}
          className="px-2.5 py-1.5 text-[11px] rounded hover:opacity-80 transition-opacity"
          style={{ backgroundColor: npcColor + '30', color: npcColor }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
