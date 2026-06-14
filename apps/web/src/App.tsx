import { useRef, useState, useEffect, useCallback } from 'react';
import { PhaserGame } from './PhaserGame';
import { EventBus } from './game/EventBus';
import { WorldClient } from './game/systems/WorldClient';
import { DreamMode } from './game/systems/DreamMode';
import { AgentRoster } from './components/AgentRoster';
import { ThoughtBubble } from './components/ThoughtBubble';
import { SpeechBubble } from './components/SpeechBubble';
import { ChatSession } from './components/chat/ChatSession';
import { HUD } from './components/HUD';
import { WelcomeCard } from './components/WelcomeCard';
import { SleepOverlay } from './components/SleepOverlay';
import { ChroniclePanel } from './components/chronicle/ChroniclePanel';
import { useViewport } from './lib/useViewport';
import { locationForScene } from './game/data/location-anchors';
import type { LocationId, DayPhase } from '@town/contract';
import type { ThomasId, ThoughtBubbleData } from './lib/types';

// A Tier-0 ambient speech bubble, positioned via the NPC's live screen
// position. Auto-expires; expiry scales with text length (longer line = longer
// dwell), bounded so a 600-char line still clears in a few seconds.
interface SpeechBubbleData {
  id: string;
  npcId: ThomasId;
  text: string;
}

function speechDwellMs(text: string): number {
  // ~6s base, +18ms/char, capped at 10s (design doc §1).
  return Math.min(10000, 4000 + text.length * 18);
}

// Whether a world event is LIVE (just happened) vs a REPLAYED backlog event. On
// reconnect/late-join the server replays a window of recent events to catch the
// scene up; those carry old timestamps and must update state silently rather than
// pop a transient bubble for each. Missing ts → treat as live (don't suppress).
const LIVE_EVENT_WINDOW_MS = 20_000;
function isLiveEvent(ts?: string): boolean {
  if (!ts) return true;
  const t = Date.parse(ts);
  return Number.isNaN(t) || Date.now() - t < LIVE_EVENT_WINDOW_MS;
}

interface AppProps {
  visitorName: string;
  // Ghost mode: render + stream the world read-only (no visitor identity, no
  // chat). The Phaser side reads the same flag from the game registry.
  observe?: boolean;
}

function App({ visitorName, observe = false }: AppProps) {
  const worldRef = useRef<WorldClient | null>(null);
  const dreamRef = useRef<DreamMode | null>(null);

  // The agent the visitor is currently engaging via the ChatSession container —
  // mirrored here only to highlight the roster row. The session's own state
  // (tier, messages, stream) lives inside ChatSession.
  const [chatNpcId, setChatNpcId] = useState<ThomasId | null>(null);
  const [thoughtBubbles, setThoughtBubbles] = useState<ThoughtBubbleData[]>([]);
  const [speechBubbles, setSpeechBubbles] = useState<SpeechBubbleData[]>([]);
  const [locationName, setLocationName] = useState("Thomas's Town");
  // The contract location the current Phaser scene materializes — drives
  // presentation scoping (ambient bubbles render only for THIS room).
  const currentLocationRef = useRef<LocationId | null>('town');
  const [npcPositions, setNpcPositions] = useState<Record<string, { screenX: number; screenY: number }>>({});
  const [proximityNpcId, setProximityNpcId] = useState<ThomasId | null>(null);
  const [selectedNpcId, setSelectedNpcId] = useState<ThomasId | null>(null);
  // The Town Chronicle hub. Coexists with a live chat (renders above it, z 60) —
  // opening it does NOT tear the chat down. `chronicle` null => closed; non-null
  // carries any initial scoping (a tab + day from "see their day →").
  const [chronicle, setChronicle] = useState<{ tab: 'today' | 'conversations'; day: string | null } | null>(null);
  // Day-phase canvas tint + sleeping/dream fallback (design §7).
  const [worldPhase, setWorldPhase] = useState<DayPhase>('afternoon');
  const [sleeping, setSleeping] = useState(false);
  const [sleepReason, setSleepReason] = useState<'budget' | 'server-down' | null>(null);
  // Ref mirror so the sleeping-gated chat-open closure reads current state.
  const sleepingRef = useRef(false);
  sleepingRef.current = sleeping;
  const viewport = useViewport();

  // ── ChatSession seam (the container drives WorldClient through these) ──────
  // The single send path: WorldClient creates the session on the first message
  // (the visitor speaks first — there's no greeting). Opening the panel is free;
  // the sleeping/budget gate lives HERE, at send-time — sending while the town
  // sleeps surfaces the cozy error line instead of a (dead) turn.
  const handleChatSend = useCallback((npcId: ThomasId, text: string) => {
    if (sleepingRef.current) {
      EventBus.emit('chat-error', { npcId, reason: 'sleeping' });
      return;
    }
    void worldRef.current?.sendMessage(npcId, text);
  }, []);

  // Visitor-initiated close. Tear the server session down iff one existed (an
  // idle panel that never sent a message cost nothing). The agent-initiated end
  // path (chat-ended) tears the session down inside WorldClient, not here.
  const handleChatSessionClose = useCallback((npcId: ThomasId | null, hadSession: boolean) => {
    if (hadSession) worldRef.current?.closeChat();
    if (npcId) EventBus.emit('chat-closed', { npcId });
  }, []);

  // Roster click just mirrors the selection for the row highlight — the profile
  // popover (with bio + actions) is owned by AgentRoster itself now (M2.1).
  const handleRosterClick = useCallback((id: ThomasId) => {
    setSelectedNpcId(id);
  }, []);

  // Chronicle toggle. Coexists with a live chat (renders above it) — opening it
  // never tears the chat down. Opens on Today, latest day.
  const handleToggleChronicle = useCallback(() => {
    setChronicle((prev) => (prev ? null : { tab: 'today', day: null }));
  }, []);

  // "see their day →" (profile popover): open the Chronicle on the Conversations
  // tab (the closest agent-scoped view — /chronicle has no agent filter).
  const handleSeeTheirDay = useCallback((_id: ThomasId) => {
    setChronicle({ tab: 'conversations', day: null });
  }, []);

  const handleTravelToAgent = useCallback((_id: ThomasId, locationId: LocationId) => {
    EventBus.emit('travel-to-location', { locationId });
  }, []);

  useEffect(() => {
    const world = new WorldClient(visitorName, { observe });
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
    const onSceneChanged = (data: { scene: string; locationName: string; locationId?: LocationId }) => {
      setLocationName(data.locationName);
      const loc = locationForScene(data.scene);
      currentLocationRef.current = loc;
      // Bubbles from the room we just left don't belong here.
      setSpeechBubbles([]);
      if (loc) world.reportLocation(loc);
    };
    const onNpcThought = (data: { npcId: ThomasId; thought: string; ts?: string }) => {
      // Pop a bubble only for LIVE events. Reconnect/late-join replays a window of
      // recent events to catch the scene up — those carry old timestamps and must
      // NOT flood the screen with stale thought wisps.
      if (!isLiveEvent(data.ts)) return;
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
    // Tier-0 ambient speech: render an in-world bubble ONLY when the speech
    // happened in the room the visitor is standing in (presentation scoping) AND
    // it's a live event (not a replayed backlog event — see onNpcThought).
    const onNpcSpeech = (data: { npcId: ThomasId; message: string; location?: LocationId; ts?: string }) => {
      const here = currentLocationRef.current;
      if (!data.location || data.location !== here) return;
      if (!isLiveEvent(data.ts)) return;
      const bubble: SpeechBubbleData = {
        id: `${data.npcId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        npcId: data.npcId,
        text: data.message,
      };
      setSpeechBubbles(prev => [...prev, bubble]);
      setTimeout(() => {
        setSpeechBubbles(prev => prev.filter(b => b.id !== bubble.id));
      }, speechDwellMs(data.message));
    };
    // Mirror the chatting agent for the roster highlight. WorldClient emits
    // chat-opened when a session is created; both close paths clear it.
    const onChatOpened = (data: { npcId: ThomasId }) => {
      setChatNpcId(data.npcId);
      setSelectedNpcId(data.npcId);
    };
    const onChatClosed = () => setChatNpcId(null);
    const onChatEnded = () => setChatNpcId(null);
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
    // A clicked fixture (e.g. the park payphone) → POST /visitors/:id/interact.
    const onVisitorInteract = (data: { locationId: LocationId; fixture: string }) => {
      world.interact(data.locationId, data.fixture);
    };

    EventBus.on('current-scene-ready', onSceneReady);
    EventBus.on('visitor-interact', onVisitorInteract);
    EventBus.on('npc-interaction', onNpcInteraction);
    EventBus.on('scene-changed', onSceneChanged);
    EventBus.on('npc-thought', onNpcThought);
    EventBus.on('npc-speech', onNpcSpeech);
    EventBus.on('chat-opened', onChatOpened);
    EventBus.on('chat-closed', onChatClosed);
    EventBus.on('chat-ended', onChatEnded);
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
      EventBus.off('scene-changed', onSceneChanged);
      EventBus.off('npc-thought', onNpcThought);
      EventBus.off('npc-speech', onNpcSpeech);
      EventBus.off('chat-opened', onChatOpened);
      EventBus.off('chat-closed', onChatClosed);
      EventBus.off('chat-ended', onChatEnded);
      EventBus.off('npc-screen-position', onNpcScreenPosition);
      EventBus.off('npc-proximity-enter', onProximityEnter);
      EventBus.off('npc-proximity-exit', onProximityExit);
      EventBus.off('world-state', onWorldState);
      EventBus.off('world-sleeping', onWorldSleeping);
      EventBus.off('visitor-interact', onVisitorInteract);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          onSeeTheirDay={handleSeeTheirDay}
        />
      )}

      <div className="flex-1 relative overflow-hidden" style={{ background: 'var(--paper)' }}>
        <PhaserGame observe={observe} />

        {/* Day-phase tint + sleeping/dream fallback over the canvas. */}
        <SleepOverlay phase={worldPhase} sleeping={sleeping} reason={sleepReason} />

        <div className="absolute inset-0 pointer-events-none">
          <HUD
            locationName={locationName}
            visitorName={visitorName}
            onToggleChronicle={handleToggleChronicle}
            chronicleOpen={chronicle != null}
            touch={viewport.touch}
          />

          {/* One-time premise framing for first-time visitors. */}
          {!observe && <WelcomeCard touch={viewport.touch} />}

          {/* Ghost-mode badge: you can walk, nobody can see you. */}
          {observe && (
            <div className="absolute top-3 left-1/2 pointer-events-none" style={{ transform: 'translateX(-50%)' }}>
              <div
                className="rounded-full px-3 py-1"
                style={{ background: 'rgba(43,38,32,0.78)', color: '#fff', font: '600 10px var(--mono)', letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                observing — unseen
              </div>
            </div>
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
              screenX={npcPositions[bubble.npcId]?.screenX || 0}
              screenY={npcPositions[bubble.npcId]?.screenY || 0}
            />
          ))}

          {/* The one persistent chat container — a side-docked popup (bottom
              sheet on narrow). Mounted once; self-manages from the EventBus
              chat stream + npc-interaction. The visitor speaks first; the
              container drives WorldClient through onSend/onClose. The Chronicle
              hub takes keyboard precedence, so the chat suspends its key ladder
              while the hub is open. */}
          {!observe && (
            <ChatSession
              onSend={handleChatSend}
              onClose={handleChatSessionClose}
              suspended={chronicle != null}
            />
          )}

          {/* Town Chronicle hub — full-screen popup ABOVE the chat (z 60). It
              coexists with a live chat: opening it never tears the chat down
              (the chat may keep streaming underneath the scrim). */}
          {chronicle && (
            <ChroniclePanel
              onClose={() => setChronicle(null)}
              initialTab={chronicle.tab}
              initialDay={chronicle.day}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
