import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ShareCard, LocationId } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';
import { locationLabel } from '@/components/chronicle/chroniclePresentation';
import { sameScene } from '@/game/data/location-anchors';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { agentColor, agentShortName } from './primitives';
import { ChatPanel } from './ChatPanel';
import type { ChatLine, ChatTarget } from './types';

// ── The one persistent chat container (M2.1) ─────────────────────────────────
//
// ONE mounted component owns the phase / target / message list. It renders the
// single ChatPanel presentation (side-docked popup, or a bottom sheet on a
// narrow viewport) and drives WorldClient through the onSend/onClose seam.
//
// There is no greeting and no two-step gate: the visitor speaks first. Opening
// the panel is local + free (idle phase); sending the first message creates the
// session server-side (WorldClient.sendMessage). The agent keeps full agency
// mid-chat — it can walk (agent.moved still flows), make things (action lines),
// and end the chat itself (chat_ended → ended phase).
//
// Focus model: the visitor can WALK while chatting. The Player freezes movement
// ONLY while the chat input is focused (typing-focus). This container tracks
// focus to drive the ESC/Enter/SPACE ladder, and bumps `focusNonce` to refocus
// the input imperatively.

interface ChatSessionProps {
  // WorldClient seam.
  onSend: (npcId: ThomasId, text: string) => void; // POST /chats (if new) + /messages
  onClose: (npcId: ThomasId | null, hadSession: boolean) => void; // POST /close if a session existed
  // The Chronicle hub owns the keyboard while open — the chat suspends its own
  // key handling (ESC/Enter/SPACE) so the two don't fight.
  suspended: boolean;
  // The contract location the visitor is currently standing in. Scopes "room"
  // speech + co-presence so the panel reads as a group conversation: other
  // co-located facets' agent.spoke land in the transcript, and arrivals/
  // departures show as diegetic lines. Null until the first scene resolves.
  currentLocation: LocationId | null;
}

// How long after an agent streams a chat reply we treat its matching room-speech
// (agent.spoke) event as a duplicate echo and suppress it from the transcript.
const STREAM_ECHO_WINDOW_MS = 20_000;

// ── reducer state ────────────────────────────────────────────────────────────
type Phase = 'closed' | 'idle' | 'live' | 'ended';

interface State {
  phase: Phase;
  target: ChatTarget | null;
  lines: ChatLine[];
  // The speaker whose turn is currently streaming (null between turns).
  streamingSpeaker: ThomasId | null;
  // True once a message was sent (a server session exists) — gates whether
  // close needs a network teardown.
  hadSession: boolean;
}

const INITIAL: State = {
  phase: 'closed',
  target: null,
  lines: [],
  streamingSpeaker: null,
  hadSession: false,
};

type Action =
  | { t: 'target'; target: ChatTarget }
  | { t: 'visitor-line'; text: string }
  | { t: 'turn-started'; speaker: ThomasId }
  | { t: 'delta'; speaker: ThomasId; text: string }
  | { t: 'memory'; speaker: ThomasId; label: string }
  | { t: 'turn-done'; speaker: ThomasId }
  // A co-located facet (not the one streaming to us) spoke to the room — render
  // it as a finished agent bubble so the conversation reads as a group.
  | { t: 'room-line'; speaker: ThomasId; text: string }
  | { t: 'action'; speaker: ThomasId; detail: string }
  | { t: 'share-card'; speaker: ThomasId; card: ShareCard }
  | { t: 'ended'; speaker: ThomasId; reason?: string | null }
  | { t: 'error'; reason: string }
  | { t: 'close' };

let lineSeq = 0;
const nextId = () => `cl-${Date.now()}-${lineSeq++}`;

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case 'target':
      // Open (or retarget to) an agent — fresh idle session, no network yet.
      return { ...INITIAL, phase: 'idle', target: a.target };

    case 'visitor-line':
      return {
        ...state,
        phase: state.phase === 'idle' ? 'live' : state.phase,
        hadSession: true,
              lines: [...state.lines, { id: nextId(), kind: 'visitor', speaker: 'visitor', text: a.text }],
      };

    case 'turn-started':
      return {
        ...state,
        phase: 'live',
        streamingSpeaker: a.speaker,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'agent', speaker: a.speaker, text: '', streaming: true },
        ],
      };

    case 'delta': {
      // Append to the open streaming bubble for this speaker. If none exists (a
      // delta arrived before turn_started), open one.
      const idx = lastStreamingIdx(state.lines, a.speaker);
      if (idx === -1) {
        return {
          ...state,
          phase: 'live',
          streamingSpeaker: a.speaker,
          lines: [
            ...state.lines,
            { id: nextId(), kind: 'agent', speaker: a.speaker, text: a.text, streaming: true },
          ],
        };
      }
      const lines = state.lines.slice();
      lines[idx] = { ...lines[idx], text: lines[idx].text + a.text };
      return { ...state, phase: 'live', lines };
    }

    case 'memory': {
      const idx = lastStreamingIdx(state.lines, a.speaker);
      if (idx === -1) return state;
      const lines = state.lines.slice();
      lines[idx] = { ...lines[idx], memory: a.label };
      return { ...state, lines };
    }

    case 'turn-done': {
      const idx = lastStreamingIdx(state.lines, a.speaker);
      if (idx === -1) return { ...state, streamingSpeaker: null };
      const lines = state.lines.slice();
      lines[idx] = { ...lines[idx], streaming: false };
      return { ...state, streamingSpeaker: null, lines };
    }

    case 'room-line':
      // Another co-located facet spoke to the room (not via our chat stream) —
      // append a finished agent bubble so the visitor sees the group talk.
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'agent', speaker: a.speaker, text: a.text },
        ],
      };

    case 'action':
      // The agent acted mid-chat — a centered diegetic line.
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'action', speaker: a.speaker, text: a.detail },
        ],
      };

    case 'share-card':
      // The agent shared a concrete card — a distinct line in the transcript.
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'share-card', speaker: a.speaker, text: a.card.title, card: a.card },
        ],
      };

    case 'ended':
      // The agent ended the chat itself — a goodbye system line; the input row
      // becomes a [wave goodbye] close button.
      return {
        ...state,
        phase: 'ended',
        streamingSpeaker: null,
              lines: [
          ...state.lines,
          { id: nextId(), kind: 'ended', text: endedLine(a.speaker, a.reason) },
        ],
      };

    case 'error':
      return {
        ...state,
        lines: [...state.lines, { id: nextId(), kind: 'system', text: errorLine(a.reason) }],
      };

    case 'close':
      return INITIAL;

    default:
      return state;
  }
}

function lastStreamingIdx(lines: ChatLine[], speaker: ThomasId): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === 'agent' && lines[i].speaker === speaker && lines[i].streaming) return i;
  }
  return -1;
}

function endedLine(speaker: ThomasId, reason?: string | null): string {
  const who = agentShortName(speaker);
  return reason ? `${who} wrapped up: ${reason}` : `${who} headed back to work.`;
}

function errorLine(reason: string): string {
  if (reason === 'mid-thought')
    return 'Deep in thought right now — give it a few seconds and try again.';
  if (reason === 'engaged') return "They're with another visitor right now. Try again in a bit.";
  if (reason === 'not-connected') return 'The town is still waking up. Try again in a moment.';
  if (reason === 'sleeping')
    return "They're asleep right now — read the Chronicle to see today, and come back when the town wakes.";
  return 'The town is quiet right now. Try again shortly.';
}

export function ChatSession({ onSend, onClose, suspended, currentLocation }: ChatSessionProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const statuses = useAgentStatuses();

  // Stable refs the EventBus / key closures read without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const currentLocationRef = useRef(currentLocation);
  currentLocationRef.current = currentLocation;
  // De-dupe room speech by source event id (replay / re-delivery safe).
  const seenSpeechIds = useRef<Set<string>>(new Set());
  // When each agent last streamed a chat-frame reply. A streamed reply ALSO
  // arrives over SSE as agent.spoke (the server speaks visitor replies to the
  // room too); suppress that echo for a short window so retargeting to another
  // facet doesn't re-append the previous speaker's last line as a room bubble.
  const lastStreamAt = useRef<Map<ThomasId, number>>(new Map());
  // Whether the chat input is currently focused (drives the ESC/Enter ladder).
  const focusedRef = useRef(false);
  // Bumped to imperatively refocus the ChatPanel input. Lives in a ref so the
  // EventBus closures stay stable; bumpFocus() also forces a re-render to push
  // the new value down to ChatPanel.
  const focusNonceRef = useRef(0);
  const [, forceRender] = useForceRender();
  const bumpFocus = useCallback(() => {
    focusNonceRef.current += 1;
    forceRender();
  }, [forceRender]);

  // ── EventBus wiring (one subscription block; stable handlers) ──────────────
  useEffect(() => {
    // Interact (SPACE near an agent / tap-an-agent): open or retarget.
    const onInteraction = (p: { npcId: ThomasId; npcName: string }) => {
      const s = stateRef.current;
      if (s.phase !== 'closed' && s.target?.npcId === p.npcId) {
        // Same agent we're already talking to → just refocus the input.
        bumpFocus();
        return;
      }
      // A different agent: while idle this is a free retarget; while live/ended
      // close the current session (network if it had one) then open the new one.
      if (s.phase === 'live' || s.phase === 'ended') {
        onClose(s.target?.npcId ?? null, s.hadSession);
      }
      const activity = statusLine(statusesRef.current[p.npcId]);
      dispatch({ t: 'target', target: { npcId: p.npcId, npcName: p.npcName, activity } });
    };

    // Proximity-exit no longer closes the panel — walking away is allowed; the
    // session keeps streaming. (Only ESC / × / chat_ended close it.)

    // Guard: drop chat-* stream events while closed (a frame racing a close).
    const live = () => stateRef.current.phase !== 'closed';

    const onTurnStarted = (p: { npcId: ThomasId }) => {
      lastStreamAt.current.set(p.npcId, Date.now());
      if (live()) dispatch({ t: 'turn-started', speaker: p.npcId });
    };
    const onDelta = (p: { npcId: ThomasId; text: string }) => {
      lastStreamAt.current.set(p.npcId, Date.now());
      if (live()) dispatch({ t: 'delta', speaker: p.npcId, text: p.text });
    };
    const onMemory = (p: { npcId: ThomasId; label: string }) => {
      if (live()) dispatch({ t: 'memory', speaker: p.npcId, label: p.label });
    };
    const onTurnDone = (p: { npcId: ThomasId }) => {
      lastStreamAt.current.set(p.npcId, Date.now());
      if (live()) dispatch({ t: 'turn-done', speaker: p.npcId });
    };
    const onAction = (p: { npcId: ThomasId; detail: string }) => {
      if (live()) dispatch({ t: 'action', speaker: p.npcId, detail: p.detail });
    };
    const onShareCard = (p: { npcId: ThomasId; card: ShareCard }) => {
      if (live()) dispatch({ t: 'share-card', speaker: p.npcId, card: p.card });
    };
    const onEnded = (p: { npcId: ThomasId; reason?: string | null }) => {
      if (live()) dispatch({ t: 'ended', speaker: p.npcId, reason: p.reason ?? null });
    };
    const onError = (p: { reason: string }) => {
      if (live()) dispatch({ t: 'error', reason: p.reason });
    };
    const onTypingFocus = (p: { focused: boolean }) => {
      focusedRef.current = p.focused;
    };

    // Room speech: a co-located facet (NOT the one streaming to us) spoke aloud.
    // Land it in the transcript so the visitor sees the group conversation —
    // the very thing they were missing (agents talk to the room; the panel was
    // 1:1). The target itself talks via the chat stream, so suppress its
    // agent.spoke to avoid a double.
    const onRoomSpeech = (p: {
      npcId: ThomasId;
      message: string;
      location?: LocationId;
      id?: string;
    }) => {
      const s = stateRef.current;
      if (s.phase === 'closed' || !s.target) return;
      const here = currentLocationRef.current;
      if (!here || !p.location || !sameScene(p.location, here)) return;
      // The target talks to us via the chat stream — its agent.spoke echo would
      // double. So would a just-streamed reply from a former target (retarget
      // edge), so also skip any agent that streamed within the echo window.
      if (p.npcId === s.target.npcId) return;
      const streamedAt = lastStreamAt.current.get(p.npcId) ?? 0;
      if (Date.now() - streamedAt < STREAM_ECHO_WINDOW_MS) return;
      if (p.id) {
        if (seenSpeechIds.current.has(p.id)) return;
        seenSpeechIds.current.add(p.id);
      }
      dispatch({ t: 'room-line', speaker: p.npcId, text: p.message });
    };

    EventBus.on('npc-interaction', onInteraction);
    EventBus.on('npc-speech', onRoomSpeech);
    EventBus.on('chat-turn-started', onTurnStarted);
    EventBus.on('chat-delta', onDelta);
    EventBus.on('chat-memory-recalled', onMemory);
    EventBus.on('chat-turn-done', onTurnDone);
    EventBus.on('chat-action', onAction);
    EventBus.on('chat-share-card', onShareCard);
    EventBus.on('chat-ended', onEnded);
    EventBus.on('chat-error', onError);
    EventBus.on('typing-focus', onTypingFocus);

    return () => {
      EventBus.off('npc-interaction', onInteraction);
      EventBus.off('npc-speech', onRoomSpeech);
      EventBus.off('chat-turn-started', onTurnStarted);
      EventBus.off('chat-delta', onDelta);
      EventBus.off('chat-memory-recalled', onMemory);
      EventBus.off('chat-turn-done', onTurnDone);
        EventBus.off('chat-action', onAction);
      EventBus.off('chat-share-card', onShareCard);
      EventBus.off('chat-ended', onEnded);
      EventBus.off('chat-error', onError);
      EventBus.off('typing-focus', onTypingFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, bumpFocus]);

  // ── co-presence (who else is in the room) + arrival/departure lines ────────
  // Derived from live agent statuses scoped to the visitor's room. Diffed across
  // renders to drop a diegetic "X walked over." / "X stepped away." line so the
  // room reads as alive (e.g. Hobby summons Writer → Writer walks in → a line).
  const presentRef = useRef<ThomasId[]>([]);
  const presenceInitRef = useRef(false);
  // The room the presence baseline was taken in — when the visitor walks to a
  // different scene mid-chat, re-baseline instead of diffing the new room's
  // occupants against the old room's (which would spam false walked-over lines).
  const presenceSceneRef = useRef<LocationId | null>(null);
  useEffect(() => {
    if (state.phase === 'closed' || !currentLocation) {
      presenceInitRef.current = false;
      presenceSceneRef.current = null;
      presentRef.current = [];
      return;
    }
    const present = (Object.keys(statuses) as ThomasId[]).filter((id) => {
      const st = statuses[id];
      return !!st && sameScene(st.locationId, currentLocation);
    });
    const roomChanged =
      presenceSceneRef.current == null || !sameScene(presenceSceneRef.current, currentLocation);
    if (!presenceInitRef.current || roomChanged) {
      // First read for this session, or the visitor moved rooms — adopt the room
      // as-is, don't announce.
      presenceInitRef.current = true;
      presenceSceneRef.current = currentLocation;
      presentRef.current = present;
      return;
    }
    const prev = presentRef.current;
    const target = state.target?.npcId;
    presentRef.current = present;
    for (const id of present) {
      if (!prev.includes(id) && id !== target) {
        dispatch({ t: 'action', speaker: id, detail: `${agentShortName(id)} walked over.` });
      }
    }
    for (const id of prev) {
      if (!present.includes(id) && id !== target) {
        dispatch({ t: 'action', speaker: id, detail: `${agentShortName(id)} stepped away.` });
      }
    }
  }, [statuses, currentLocation, state.phase, state.target?.npcId]);

  // The co-located facets other than the one we're addressing — rendered as a
  // presence bar the visitor can tap to bring another facet into focus.
  const present = useMemo(() => {
    const target = state.target?.npcId;
    if (!target || !currentLocation) return [] as ThomasId[];
    return (Object.keys(statuses) as ThomasId[]).filter((id) => {
      const st = statuses[id];
      return id !== target && !!st && sameScene(st.locationId, currentLocation);
    });
  }, [statuses, currentLocation, state.target?.npcId]);

  // Tap a present facet → retarget the conversation to them (reuses the same
  // interaction path SPACE/tap uses; the reducer closes + reopens cleanly).
  const handleAddress = useCallback((npcId: ThomasId) => {
    const npcName = NPC_CONFIGS[npcId]?.displayName ?? `${agentShortName(npcId)} Thomas`;
    EventBus.emit('npc-interaction', { npcId, npcName });
  }, []);

  const doClose = useCallback(() => {
    const s = stateRef.current;
    onClose(s.target?.npcId ?? null, s.hadSession);
    dispatch({ t: 'close' });
  }, [onClose]);

  const handleSend = useCallback(
    (text: string) => {
      const s = stateRef.current;
      const t = text.trim();
      if (!t || !s.target || s.phase === 'ended') return;
      dispatch({ t: 'visitor-line', text: t });
      onSend(s.target.npcId, t);
    },
    [onSend]
  );

  // ── key ladder (window-level; suspended while the hub owns the keyboard) ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspendedRef.current) return; // hub takes precedence
      const s = stateRef.current;
      if (s.phase === 'closed') return;

      if (e.key === 'Escape') {
        // ESC ladder: input focused → blur (so movement resumes); unfocused →
        // close the panel.
        if (focusedRef.current) {
          (document.activeElement as HTMLElement | null)?.blur();
        } else {
          doClose();
        }
        return;
      }
      // Enter while the chat is open + the input is NOT focused refocuses it
      // (so the visitor can walk, then hit Enter to type again).
      if (e.key === 'Enter' && !focusedRef.current) {
        e.preventDefault();
        bumpFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doClose, bumpFocus]);

  const liveStatus = state.target ? statuses[state.target.npcId] : undefined;
  const color = useMemo(
    () => (state.target ? agentColor(state.target.npcId) : 'var(--career)'),
    [state.target]
  );

  if (state.phase === 'closed' || !state.target) return null;

  return (
    <ChatPanel
      target={state.target}
      color={color}
      lines={state.lines}
      streamingSpeaker={state.streamingSpeaker}
      phase={state.phase}
      liveActivity={
        // Activity lines can be hours stale ("sitting on the bench at dawn"
        // while the agent is in the library) — anchor them with the live place.
        liveStatus
          ? `${statusLine(liveStatus)} · ${locationLabel(liveStatus.locationId)}`
          : state.target.activity
      }
      onSend={handleSend}
      onClose={doClose}
      focusNonce={focusNonceRef.current}
      present={present}
      onAddress={handleAddress}
    />
  );
}

// Tiny force-render hook for the imperative focus bump (focusNonce lives in a
// ref so the EventBus closures stay stable; this re-renders to push it down).
function useForceRender(): [number, () => void] {
  const [n, setN] = useReducer((x: number) => x + 1, 0);
  return [n, setN as unknown as () => void];
}
