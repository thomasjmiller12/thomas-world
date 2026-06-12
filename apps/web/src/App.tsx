import { useRef, useState, useEffect, useCallback } from 'react';
import { PhaserGame } from './PhaserGame';
import { EventBus } from './game/EventBus';
import { WorldClient } from './game/systems/WorldClient';
import { DreamMode } from './game/systems/DreamMode';
import { AgentRoster } from './components/AgentRoster';
import { RightPanel } from './components/RightPanel';
import { DialogBox } from './components/DialogBox';
import { ThoughtBubble } from './components/ThoughtBubble';
import { HUD } from './components/HUD';
import { locationForScene } from './game/data/location-anchors';
import type { ThomasId, ChatMessage, ThoughtBubbleData, DialogData } from './lib/types';

interface AppProps {
  visitorName: string;
}

function App({ visitorName }: AppProps) {
  const worldRef = useRef<WorldClient | null>(null);
  const dreamRef = useRef<DreamMode | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatNpcId, setChatNpcId] = useState<ThomasId | null>(null);
  const [chatNpcName, setChatNpcName] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogData, setDialogData] = useState<DialogData | null>(null);
  const [thoughtBubbles, setThoughtBubbles] = useState<ThoughtBubbleData[]>([]);
  const [locationName, setLocationName] = useState("Thomas's Town");
  const [npcPositions, setNpcPositions] = useState<Record<string, { screenX: number; screenY: number }>>({});
  const [proximityNpcId, setProximityNpcId] = useState<ThomasId | null>(null);
  const [selectedNpcId, setSelectedNpcId] = useState<ThomasId | null>(null);
  const [rightPanelVisible, setRightPanelVisible] = useState(false);

  const handleChatSend = useCallback((message: string) => {
    if (!chatNpcId) return;
    const visitorMsg: ChatMessage = {
      sender: 'visitor',
      senderName: visitorName,
      text: message,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, visitorMsg]);
    // Visitor line → WorldClient streams the reply (npc-chat-response per turn).
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

  const handleRosterClick = useCallback((id: ThomasId) => {
    setSelectedNpcId(prev => prev === id ? null : id);
    setRightPanelVisible(true);
  }, []);

  const handleToggleRightPanel = useCallback(() => {
    setRightPanelVisible(prev => !prev);
  }, []);

  useEffect(() => {
    const world = new WorldClient(visitorName);
    const dream = new DreamMode();
    worldRef.current = world;
    dreamRef.current = dream;

    // Keep handler refs so unmount removes ONLY our own listeners (no bare
    // removeAllListeners — that would nuke the Phaser scenes' listeners too,
    // which breaks under React StrictMode / HMR remounts).
    const onSceneReady = () => {
      void world.start();
    };
    const onNpcInteraction = (data: { npcId: ThomasId; npcName: string }) => {
      setChatNpcId(data.npcId);
      setChatNpcName(data.npcName);
      setChatMessages([]);
      setChatOpen(true);
      setSelectedNpcId(data.npcId);
      setRightPanelVisible(true);
      // Escalate: ask WorldClient to open the session + stream the greeting.
      EventBus.emit('chat-open-request', { npcId: data.npcId });
    };
    const onChatResponse = (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
    };
    const onChatError = (data: { npcId?: ThomasId; reason: string }) => {
      // Surface the failure in-panel as a system line (full Tier-1 alternatives
      // land in F2; this keeps the panel honest meanwhile).
      const line =
        data.reason === 'engaged'
          ? "He's deep in something right now — try again in a moment."
          : 'The town is quiet right now. Try again shortly.';
      setChatMessages(prev => [...prev, {
        sender: data.npcId ?? 'hobby',
        senderName: chatNpcName || 'Thomas',
        text: line,
        timestamp: Date.now(),
      }]);
    };
    const onShowDialog = (data: DialogData) => {
      setDialogData(data);
      setDialogOpen(true);
    };
    const onSceneChanged = (data: { scene: string; locationName: string }) => {
      setLocationName(data.locationName);
      const loc = locationForScene(data.scene);
      if (loc) world.reportLocation(loc);
    };
    const onNpcThought = (data: { npcId: ThomasId; thought: string }) => {
      const bubble: ThoughtBubbleData = {
        id: `${data.npcId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        npcId: data.npcId,
        text: data.thought,
        screenX: 0,
        screenY: 0,
      };
      setThoughtBubbles(prev => [...prev, bubble]);
      setTimeout(() => {
        setThoughtBubbles(prev => prev.filter(b => b.id !== bubble.id));
      }, 5000);
    };
    const onNpcScreenPosition = (data: { npcId: string; screenX: number; screenY: number }) => {
      setNpcPositions(prev => ({
        ...prev,
        [data.npcId]: { screenX: data.screenX, screenY: data.screenY },
      }));
    };
    const onProximityEnter = (data: { npcId: ThomasId }) => {
      setProximityNpcId(data.npcId);
    };
    const onProximityExit = (data: { npcId: ThomasId }) => {
      setProximityNpcId(prev => prev === data.npcId ? null : prev);
    };
    // Degraded mode: if WorldClient can't reach the server / budget is gone,
    // run the free scripted dream layer so the town reads asleep, not broken.
    const onWorldSleeping = (data: { sleeping: boolean }) => {
      if (data.sleeping) dream.start();
      else dream.stop();
    };

    EventBus.on('current-scene-ready', onSceneReady);
    EventBus.on('npc-interaction', onNpcInteraction);
    EventBus.on('npc-chat-response', onChatResponse);
    EventBus.on('chat-error', onChatError);
    EventBus.on('show-dialog', onShowDialog);
    EventBus.on('scene-changed', onSceneChanged);
    EventBus.on('npc-thought', onNpcThought);
    EventBus.on('npc-screen-position', onNpcScreenPosition);
    EventBus.on('npc-proximity-enter', onProximityEnter);
    EventBus.on('npc-proximity-exit', onProximityExit);
    EventBus.on('world-sleeping', onWorldSleeping);

    return () => {
      dream.stop();
      world.stop();
      EventBus.off('current-scene-ready', onSceneReady);
      EventBus.off('npc-interaction', onNpcInteraction);
      EventBus.off('npc-chat-response', onChatResponse);
      EventBus.off('chat-error', onChatError);
      EventBus.off('show-dialog', onShowDialog);
      EventBus.off('scene-changed', onSceneChanged);
      EventBus.off('npc-thought', onNpcThought);
      EventBus.off('npc-screen-position', onNpcScreenPosition);
      EventBus.off('npc-proximity-enter', onProximityEnter);
      EventBus.off('npc-proximity-exit', onProximityExit);
      EventBus.off('world-sleeping', onWorldSleeping);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-[#15132a]">
      <AgentRoster
        proximityNpcId={proximityNpcId}
        chatNpcId={chatNpcId}
        selectedNpcId={selectedNpcId}
        onNpcClick={handleRosterClick}
      />

      <div className="flex-1 relative overflow-hidden bg-[#15132a]">
        <PhaserGame />

        <div className="absolute inset-0 pointer-events-none">
          <HUD locationName={locationName} visitorName={visitorName} />

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

      <RightPanel
        chatOpen={chatOpen}
        chatNpcId={chatNpcId}
        chatNpcName={chatNpcName}
        chatMessages={chatMessages}
        onChatSend={handleChatSend}
        onChatClose={handleChatClose}
        selectedNpcId={selectedNpcId}
        visible={rightPanelVisible}
        onToggle={handleToggleRightPanel}
      />
    </div>
  );
}

export default App;
