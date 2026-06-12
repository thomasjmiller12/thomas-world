import { useRef, useState, useEffect, useCallback } from 'react';
import { PhaserGame } from './PhaserGame';
import { EventBus } from './game/EventBus';
import { WorldClient } from './game/systems/WorldClient';
import { DreamMode } from './game/systems/DreamMode';
import { AgentRoster } from './components/AgentRoster';
import { RightPanel } from './components/RightPanel';
import { DialogBox } from './components/DialogBox';
import { ThoughtBubble } from './components/ThoughtBubble';
import { SpeechBubble } from './components/SpeechBubble';
import { SceneTranscriptStrip, type TranscriptLine } from './components/SceneTranscriptStrip';
import { ChatSession } from './components/chat/ChatSession';
import type { BusyAlternative } from './components/chat/types';
import { HUD } from './components/HUD';
import { locationForScene, sameScene } from './game/data/location-anchors';
import type { LocationId } from '@town/contract';
import type { ThomasId, ThoughtBubbleData, DialogData } from './lib/types';

// A Tier-0 speech bubble (ambient or scene turn), positioned via the NPC's live
// screen position. Auto-expires; expiry scales with text length (longer line =
// longer dwell), bounded so a 600-char line still clears in a few seconds.
interface SpeechBubbleData {
  id: string;
  npcId: ThomasId;
  text: string;
  scene: boolean;
}

// A live agent↔agent scene the visitor can overhear / join (Tier 1.5).
interface LiveScene {
  conversationId: string;
  location: LocationId;
  participants: ThomasId[];
  lines: TranscriptLine[];
}

function speechDwellMs(text: string): number {
  // ~6s base, +18ms/char, capped at 10s (design doc §1).
  return Math.min(10000, 4000 + text.length * 18);
}

interface AppProps {
  visitorName: string;
}

function App({ visitorName }: AppProps) {
  const worldRef = useRef<WorldClient | null>(null);
  const dreamRef = useRef<DreamMode | null>(null);

  // The agent the visitor is currently engaging via the ChatSession container —
  // mirrored here only to highlight the roster row. The session's own state
  // (tier, messages, stream) lives inside ChatSession.
  const [chatNpcId, setChatNpcId] = useState<ThomasId | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogData, setDialogData] = useState<DialogData | null>(null);
  const [thoughtBubbles, setThoughtBubbles] = useState<ThoughtBubbleData[]>([]);
  const [speechBubbles, setSpeechBubbles] = useState<SpeechBubbleData[]>([]);
  const [liveScenes, setLiveScenes] = useState<Record<string, LiveScene>>({});
  // Ref mirror so the EventBus handler (a stable closure) reads current scenes
  // without re-subscribing on every state change.
  const liveScenesRef = useRef<Record<string, LiveScene>>({});
  liveScenesRef.current = liveScenes;
  const [locationName, setLocationName] = useState("Thomas's Town");
  // The contract location the current Phaser scene materializes — drives
  // presentation scoping (bubbles + transcript strip render only for THIS room).
  const currentLocationRef = useRef<LocationId | null>('town');
  const [currentLocationId, setCurrentLocationId] = useState<LocationId | null>('town');
  const [npcPositions, setNpcPositions] = useState<Record<string, { screenX: number; screenY: number }>>({});
  const [proximityNpcId, setProximityNpcId] = useState<ThomasId | null>(null);
  const [selectedNpcId, setSelectedNpcId] = useState<ThomasId | null>(null);
  const [rightPanelVisible, setRightPanelVisible] = useState(false);

  // ── ChatSession seam (the container drives WorldClient through these) ──────
  const handleChatOpen = useCallback((npcId: ThomasId) => {
    setChatNpcId(npcId);
    setSelectedNpcId(npcId);
    void worldRef.current?.openChat(npcId);
  }, []);

  const handleChatSend = useCallback((_npcId: ThomasId, text: string) => {
    void worldRef.current?.sendMessage(text);
  }, []);

  const handleChatSessionClose = useCallback((npcId: ThomasId | null, opened: boolean) => {
    setChatNpcId(null);
    // Only tell the server to tear down a session that was actually opened (an
    // un-greeted gate cost nothing — design doc §1).
    if (opened) worldRef.current?.closeChat();
    if (npcId) EventBus.emit('dialog-closed'); // release any canvas pause hook
  }, []);

  // Busy-409 [listen in]: a co-located scene's transcript strip already renders
  // for the current room (Tier 1.5). Cross-room travel rides on the FeedTimeline
  // show-in-town resolve (later F-step); here we just join if it's joinable.
  const handleListenIn = useCallback((alt: BusyAlternative) => {
    if (alt.kind === 'scene' && alt.conversationId) {
      void worldRef.current?.joinConversation(alt.conversationId);
    }
  }, []);

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

  // ⊕ Join in: escalate a listen-in scene to a group chat (Tier 1.5 → chat).
  const handleJoinScene = useCallback((conversationId: string) => {
    void worldRef.current?.joinConversation(conversationId);
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
    // The two-step greeting gate, busy path, and streaming all live inside the
    // ChatSession container (it subscribes to `npc-interaction` + the chat
    // stream events directly). App only mirrors the engaged agent for the
    // roster highlight here — the open/send/close calls go through the
    // ChatSession seam callbacks (handleChatOpen/Send/Close), not this handler.
    const onNpcInteraction = (data: { npcId: ThomasId; npcName: string }) => {
      setSelectedNpcId(data.npcId);
    };
    const onShowDialog = (data: DialogData) => {
      setDialogData(data);
      setDialogOpen(true);
    };
    const onSceneChanged = (data: { scene: string; locationName: string; locationId?: LocationId }) => {
      setLocationName(data.locationName);
      const loc = locationForScene(data.scene);
      currentLocationRef.current = loc;
      setCurrentLocationId(loc);
      // Bubbles/transcripts from the room we just left don't belong here.
      setSpeechBubbles([]);
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
    // Tier-0 speech: render an in-world bubble ONLY when the event belongs to the
    // current scene's location (presentation scoping, design doc §1, decision 10).
    const onNpcSpeech = (data: {
      npcId: ThomasId; message: string; conversationId?: string; location?: LocationId;
    }) => {
      const here = currentLocationRef.current;
      let inScene: boolean;
      if (data.conversationId) {
        // Scene turns carry no location — scope by the scene's known location.
        const sc = liveScenesRef.current[data.conversationId];
        inScene = !!sc && !!here && sameScene(sc.location, here);
        // Append to the transcript strip regardless of where it renders.
        if (sc) {
          setLiveScenes(prev => {
            const cur = prev[data.conversationId!];
            if (!cur) return prev;
            const line: TranscriptLine = {
              id: `${data.conversationId}-${cur.lines.length}-${Date.now()}`,
              npcId: data.npcId,
              text: data.message,
            };
            // Keep the strip light — last ~12 lines.
            const lines = [...cur.lines, line].slice(-12);
            return { ...prev, [data.conversationId!]: { ...cur, lines } };
          });
        }
      } else {
        inScene = !!data.location && data.location === here;
      }
      if (!inScene) return;
      const bubble: SpeechBubbleData = {
        id: `${data.npcId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        npcId: data.npcId,
        text: data.message,
        scene: !!data.conversationId,
      };
      setSpeechBubbles(prev => [...prev, bubble]);
      setTimeout(() => {
        setSpeechBubbles(prev => prev.filter(b => b.id !== bubble.id));
      }, speechDwellMs(data.message));
    };
    const onSceneStarted = (data: { conversationId: string; location: LocationId; participants: ThomasId[] }) => {
      setLiveScenes(prev => ({
        ...prev,
        [data.conversationId]: {
          conversationId: data.conversationId,
          location: data.location,
          participants: data.participants,
          lines: [],
        },
      }));
    };
    const onSceneEnded = (data: { conversationId: string }) => {
      setLiveScenes(prev => {
        if (!prev[data.conversationId]) return prev;
        const next = { ...prev };
        delete next[data.conversationId];
        return next;
      });
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
    EventBus.on('show-dialog', onShowDialog);
    EventBus.on('scene-changed', onSceneChanged);
    EventBus.on('npc-thought', onNpcThought);
    EventBus.on('npc-speech', onNpcSpeech);
    EventBus.on('scene-started', onSceneStarted);
    EventBus.on('scene-ended', onSceneEnded);
    EventBus.on('scene-converted', onSceneEnded);
    EventBus.on('npc-screen-position', onNpcScreenPosition);
    EventBus.on('npc-proximity-enter', onProximityEnter);
    EventBus.on('npc-proximity-exit', onProximityExit);
    EventBus.on('world-sleeping', onWorldSleeping);

    return () => {
      dream.stop();
      world.stop();
      EventBus.off('current-scene-ready', onSceneReady);
      EventBus.off('npc-interaction', onNpcInteraction);
      EventBus.off('show-dialog', onShowDialog);
      EventBus.off('scene-changed', onSceneChanged);
      EventBus.off('npc-thought', onNpcThought);
      EventBus.off('npc-speech', onNpcSpeech);
      EventBus.off('scene-started', onSceneStarted);
      EventBus.off('scene-ended', onSceneEnded);
      EventBus.off('scene-converted', onSceneEnded);
      EventBus.off('npc-screen-position', onNpcScreenPosition);
      EventBus.off('npc-proximity-enter', onProximityEnter);
      EventBus.off('npc-proximity-exit', onProximityExit);
      EventBus.off('world-sleeping', onWorldSleeping);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The live scene (if any) happening in the current room — drives the
  // transcript strip. Scoped so only the room you're standing in shows it.
  const activeScene =
    Object.values(liveScenes).find(
      (s) => currentLocationId != null && sameScene(s.location, currentLocationId)
    ) ?? null;

  return (
    <div className="flex w-screen h-screen overflow-hidden" style={{ background: 'var(--paper)' }}>
      <AgentRoster
        proximityNpcId={proximityNpcId}
        chatNpcId={chatNpcId}
        selectedNpcId={selectedNpcId}
        onNpcClick={handleRosterClick}
      />

      <div className="flex-1 relative overflow-hidden" style={{ background: 'var(--paper)' }}>
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

          {speechBubbles.map(bubble => (
            <SpeechBubble
              key={bubble.id}
              npcId={bubble.npcId}
              text={bubble.text}
              scene={bubble.scene}
              screenX={npcPositions[bubble.npcId]?.screenX || 0}
              screenY={npcPositions[bubble.npcId]?.screenY || 0}
            />
          ))}

          {activeScene && (
            <div className="pointer-events-auto">
              <SceneTranscriptStrip
                participants={activeScene.participants}
                lines={activeScene.lines}
                onJoin={() => handleJoinScene(activeScene.conversationId)}
              />
            </div>
          )}

          {/* The one persistent chat container — Tier-1 diegetic ↔ Tier-2
              docked, two-step greeting gate, busy path. Mounted once; it
              self-manages from the EventBus chat stream + npc-interaction. */}
          <ChatSession
            onOpen={handleChatOpen}
            onSend={handleChatSend}
            onClose={handleChatSessionClose}
            onListenIn={handleListenIn}
            currentLocationId={currentLocationId}
            liveScenes={liveScenes}
          />
        </div>
      </div>

      {/* Profile rail (roster click). The docked chat (ChatSession) takes the
          right rail when engaged; this profile-only panel collapses to make
          room. Its full restyle lands in F2. */}
      {!chatNpcId && (
        <RightPanel
          selectedNpcId={selectedNpcId}
          visible={rightPanelVisible}
          onToggle={handleToggleRightPanel}
        />
      )}
    </div>
  );
}

export default App;
