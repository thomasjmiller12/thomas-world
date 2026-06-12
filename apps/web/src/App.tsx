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
import { SleepOverlay } from './components/SleepOverlay';
import { FeedTimeline } from './components/feed/FeedTimeline';
import { useViewport } from './lib/useViewport';
import { locationForScene, sameScene } from './game/data/location-anchors';
import type { LocationId, DayPhase } from '@town/contract';
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
  // Feed slide-over. Mutually exclusive with the docked chat (panel coexistence).
  const [feedOpen, setFeedOpen] = useState(false);
  // Day-phase canvas tint + sleeping/dream fallback (design §7).
  const [worldPhase, setWorldPhase] = useState<DayPhase>('afternoon');
  const [sleeping, setSleeping] = useState(false);
  const [sleepReason, setSleepReason] = useState<'budget' | 'server-down' | null>(null);
  // Ref mirror so the sleeping-gated chat-open closure reads current state.
  const sleepingRef = useRef(false);
  sleepingRef.current = sleeping;
  const viewport = useViewport();

  // ── ChatSession seam (the container drives WorldClient through these) ──────
  const handleChatOpen = useCallback((npcId: ThomasId) => {
    // Chat is disabled while the town sleeps — the agents aren't awake to think.
    // The local (free) gate still opened; surface cozy copy instead of a turn.
    if (sleepingRef.current) {
      EventBus.emit('chat-error', { npcId, reason: 'sleeping' });
      return;
    }
    setChatNpcId(npcId);
    setSelectedNpcId(npcId);
    // Opening a chat collapses the feed (feed ⟷ docked chat are exclusive).
    setFeedOpen(false);
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
    if (npcId) {
      // Pair with the `chat-opened` engage signal: release the player input
      // freeze and the NPC's face-the-player lock immediately. (dialog-closed
      // stays for the artifact reader's separate canvas-pause hook.)
      EventBus.emit('chat-closed', { npcId });
      EventBus.emit('dialog-closed'); // release any canvas pause hook
    }
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

  // Feed toggle. Panel coexistence: opening the feed collapses any docked chat
  // (and vice-versa); below the narrow breakpoint both render full-screen.
  const handleToggleFeed = useCallback(() => {
    setFeedOpen((prev) => {
      const next = !prev;
      if (next && chatNpcId) {
        // Closing the chat to make room for the feed.
        setChatNpcId(null);
        worldRef.current?.closeChat();
      }
      return next;
    });
  }, [chatNpcId]);

  // Show-in-town (feed row) / travel-to-agent (roster engagement row): resolve a
  // location into a camera move via the active Phaser scene (design §6.3).
  const handleShowInTown = useCallback((locationId: LocationId) => {
    EventBus.emit('travel-to-location', { locationId });
    // On a narrow viewport the feed is a full-screen overlay covering the canvas
    // — close it so the move is visible.
    if (viewport.narrow) setFeedOpen(false);
  }, [viewport.narrow]);

  const handleTravelToAgent = useCallback((_id: ThomasId, locationId: LocationId) => {
    EventBus.emit('travel-to-location', { locationId });
  }, []);

  useEffect(() => {
    const world = new WorldClient(visitorName);
    const dream = new DreamMode();
    worldRef.current = world;
    dreamRef.current = dream;

    // Boot the client ONCE here — not on every `current-scene-ready`. Scene
    // transitions re-fire that event, and start() wires the overlay bridge +
    // opens the SSE stream, which must happen exactly once (re-running it leaks
    // EventSource connections and duplicates chat POSTs).
    void world.start();

    // Keep handler refs so unmount removes ONLY our own listeners (no bare
    // removeAllListeners — that would nuke the Phaser scenes' listeners too,
    // which breaks under React StrictMode / HMR remounts).
    // Per scene transition the old NPCManager is destroyed and a fresh one is
    // built empty — re-emit the cached snapshot's per-agent status so it learns
    // who belongs in the new scene (no listener re-wiring, no stream re-open).
    const onSceneReady = () => {
      world.resyncScene();
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
    // Day-phase tint (world.time / snapshot world block).
    const onWorldState = (data: { phase: DayPhase }) => {
      setWorldPhase(data.phase);
    };
    // Degraded mode: if WorldClient can't reach the server / budget is gone,
    // run the free scripted dream layer so the town reads asleep, not broken,
    // and surface the night tint + Z's + cozy copy (SleepOverlay).
    const onWorldSleeping = (data: { sleeping: boolean; reason: 'budget' | 'server-down' | null }) => {
      setSleeping(data.sleeping);
      setSleepReason(data.reason);
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
    EventBus.on('world-state', onWorldState);
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
      EventBus.off('world-state', onWorldState);
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
      {/* On a narrow viewport the roster collapses out of the way — the world
          + bottom-sheet panels own the screen (panel coexistence). */}
      {!viewport.narrow && (
        <AgentRoster
          proximityNpcId={proximityNpcId}
          chatNpcId={chatNpcId}
          selectedNpcId={selectedNpcId}
          onNpcClick={handleRosterClick}
          onTravelToAgent={handleTravelToAgent}
        />
      )}

      <div className="flex-1 relative overflow-hidden" style={{ background: 'var(--paper)' }}>
        <PhaserGame />

        {/* Day-phase tint + sleeping/dream fallback over the canvas. */}
        <SleepOverlay phase={worldPhase} sleeping={sleeping} reason={sleepReason} />

        <div className="absolute inset-0 pointer-events-none">
          <HUD
            locationName={locationName}
            visitorName={visitorName}
            onToggleFeed={handleToggleFeed}
            feedOpen={feedOpen}
            touch={viewport.touch}
          />

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

          {/* FeedTimeline slide-over — mutually exclusive with the docked chat
              (handleToggleFeed closes the chat when opening). Full-screen below
              the narrow breakpoint (panel coexistence). */}
          {feedOpen && (
            <FeedTimeline
              onClose={() => setFeedOpen(false)}
              onShowInTown={handleShowInTown}
              fullScreen={viewport.narrow}
            />
          )}
        </div>
      </div>

      {/* Profile rail (roster click). The docked chat (ChatSession) and the feed
          both take the right rail when active; this profile-only panel hides to
          make room (panel coexistence). Also hidden on narrow viewports. */}
      {!chatNpcId && !feedOpen && !viewport.narrow && (
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
