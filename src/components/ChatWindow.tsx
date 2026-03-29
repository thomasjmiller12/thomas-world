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
    <div
      className="pointer-events-auto absolute bottom-4 right-4 w-80 max-h-96 flex flex-col bg-black/90 border rounded-lg overflow-hidden shadow-2xl"
      style={{ borderColor: npcColor }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ backgroundColor: npcColor + '33' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: npcColor }} />
          <span className="text-white text-xs font-mono">{npcName}</span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">x</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-60">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.sender === 'visitor' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg text-xs leading-relaxed ${
                msg.sender === 'visitor' ? 'bg-[#4A90D9]/30 text-white' : 'text-white'
              }`}
              style={msg.sender !== 'visitor' ? { backgroundColor: npcColor + '30' } : {}}
            >
              <span className="font-bold text-[10px] block mb-1 font-mono" style={{ color: msg.sender === 'visitor' ? '#4A90D9' : npcColor }}>
                {msg.senderName}
              </span>
              <span>{msg.text}</span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-white/10 p-2 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..."
          className="flex-1 bg-white/10 text-white text-xs px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-white/30"
        />
        <button
          onClick={handleSend}
          className="px-3 py-2 text-white text-xs rounded hover:opacity-80 transition-opacity font-mono"
          style={{ backgroundColor: npcColor }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
