import { useRef, useState, useEffect, useCallback } from 'react';
import { PhaserGame } from './PhaserGame';
import { EventBus } from './game/EventBus';
import { InteractionSystem } from './game/systems/InteractionSystem';
import { AgentSimulator } from './game/systems/AgentSimulator';
import { ChatWindow } from './components/ChatWindow';
import { DialogBox } from './components/DialogBox';
import { ThoughtBubble } from './components/ThoughtBubble';
import { HUD } from './components/HUD';
import { NPC_CONFIGS } from './game/data/npc-configs';
import type { ThomasId, ChatMessage, ThoughtBubbleData, DialogData } from './lib/types';

interface AppProps {
  visitorName: string;
}

function App({ visitorName }: AppProps) {
  const simulatorRef = useRef<AgentSimulator | null>(null);
  const interactionRef = useRef<InteractionSystem | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatNpcId, setChatNpcId] = useState<ThomasId | null>(null);
  const [chatNpcName, setChatNpcName] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogData, setDialogData] = useState<DialogData | null>(null);
  const [thoughtBubbles, setThoughtBubbles] = useState<ThoughtBubbleData[]>([]);
  const [locationName, setLocationName] = useState("Thomas's Town");
  const [npcPositions, setNpcPositions] = useState<Record<string, { screenX: number; screenY: number }>>({});

  const handleChatSend = useCallback((message: string) => {
    if (!chatNpcId) return;
    const visitorMsg: ChatMessage = {
      sender: 'visitor',
      senderName: visitorName,
      text: message,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, visitorMsg]);
    EventBus.emit('chat-message-sent', { npcId: chatNpcId, message });
  }, [chatNpcId, visitorName]);

  const handleChatClose = useCallback(() => {
    setChatOpen(false);
    if (chatNpcId) {
      EventBus.emit('chat-closed', { npcId: chatNpcId });
    }
    setChatNpcId(null);
    setChatMessages([]);
  }, [chatNpcId]);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    setDialogData(null);
    EventBus.emit('dialog-closed');
  }, []);

  useEffect(() => {
    simulatorRef.current = new AgentSimulator();
    interactionRef.current = new InteractionSystem();

    EventBus.once('current-scene-ready', () => {
      simulatorRef.current?.start();
    });

    EventBus.on('npc-interaction', (data: { npcId: ThomasId; npcName: string }) => {
      const config = NPC_CONFIGS[data.npcId];
      setChatNpcId(data.npcId);
      setChatNpcName(data.npcName);
      setChatMessages([{
        sender: data.npcId,
        senderName: data.npcName,
        text: config?.greeting || 'Hello!',
        timestamp: Date.now(),
      }]);
      setChatOpen(true);
    });

    EventBus.on('npc-chat-response', (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
    });

    EventBus.on('show-dialog', (data: DialogData) => {
      setDialogData(data);
      setDialogOpen(true);
    });

    EventBus.on('scene-changed', (data: { locationName: string }) => {
      setLocationName(data.locationName);
    });

    EventBus.on('npc-thought', (data: { npcId: ThomasId; thought: string }) => {
      const bubble: ThoughtBubbleData = {
        id: `${data.npcId}-${Date.now()}`,
        npcId: data.npcId,
        text: data.thought,
        screenX: 0,
        screenY: 0,
      };
      setThoughtBubbles(prev => [...prev, bubble]);
      setTimeout(() => {
        setThoughtBubbles(prev => prev.filter(b => b.id !== bubble.id));
      }, 5000);
    });

    EventBus.on('npc-screen-position', (data: { npcId: string; screenX: number; screenY: number }) => {
      setNpcPositions(prev => ({
        ...prev,
        [data.npcId]: { screenX: data.screenX, screenY: data.screenY },
      }));
    });

    return () => {
      simulatorRef.current?.stop();
      interactionRef.current?.destroy();
      EventBus.removeAllListeners();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a2e]">
      <PhaserGame />

      <div className="absolute inset-0 pointer-events-none">
        <HUD locationName={locationName} visitorName={visitorName} />

        {chatOpen && chatNpcId && (
          <ChatWindow
            npcId={chatNpcId}
            npcName={chatNpcName}
            messages={chatMessages}
            onSend={handleChatSend}
            onClose={handleChatClose}
          />
        )}

        {dialogOpen && dialogData && (
          <DialogBox
            text={dialogData.text}
            title={dialogData.title}
            onClose={handleDialogClose}
          />
        )}

        {thoughtBubbles.map(bubble => (
          <ThoughtBubble
            key={bubble.id}
            npcId={bubble.npcId}
            text={bubble.text}
            screenX={npcPositions[bubble.npcId]?.screenX || bubble.screenX}
            screenY={npcPositions[bubble.npcId]?.screenY || bubble.screenY}
          />
        ))}
      </div>
    </div>
  );
}

export default App;
