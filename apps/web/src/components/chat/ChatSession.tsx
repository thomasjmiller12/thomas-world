import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ShareCard, LocationId } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';
import { locationLabel } from '@/components/chronicle/chroniclePresentation';
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
  onAddress: (npcId: ThomasId) => void; // focus/join without replacing the session
  // The Chronicle hub owns the keyboard while open — the chat suspends its own
  // key handling (ESC/Enter/SPACE) so the two don't fight.
  suspended: boolean;
  // The visitor's current location. It determines which nonmembers can be
  // explicitly invited; ambient speech stays on the canvas, outside the private
  // transcript. Null until the first scene resolves.
  currentLocation: LocationId | null;
}

// ── reducer state ────────────────────────────────────────────────────────────
type Phase = 'closed' | 'idle' | 'live' | 'ended';

interface State {
  phase: Phase;
  sessionId: string | null;
  target: ChatTarget | null;
  participants: ThomasId[];
  lines: ChatLine[];
  // The speaker whose turn is currently streaming (null between turns).
  streamingSpeaker: ThomasId | null;
  // True once a message was sent (a server session exists) — gates whether
  // close needs a network teardown.
  hadSession: boolean;
  // Guard so an in-flight history fetch can't prepend the same lines twice
  // (retarget → open → a late response from the previous target).
  historyLoaded: boolean;
  // Number of optimistic visitor lines that have not reached a terminal frame.
  // Rapid sends are allowed, but retargeting would abort/orphan those replies.
  pendingReplies: number;
}

const INITIAL: State = {
  phase: 'closed',
  sessionId: null,
  target: null,
  participants: [],
  lines: [],
  streamingSpeaker: null,
  hadSession: false,
  historyLoaded: false,
  pendingReplies: 0,
};

type Action =
  | { t: 'target'; target: ChatTarget }
  | { t: 'visitor-line'; text: string }
  // Prior conversation with this facet, from earlier sessions — prepended above
  // whatever is already on screen.
  | { t: 'history'; lines: ChatLine[] }
  | { t: 'turn-started'; speaker: ThomasId }
  | { t: 'delta'; speaker: ThomasId; text: string }
  | { t: 'memory'; speaker: ThomasId; label: string }
  | { t: 'turn-done'; speaker: ThomasId }
  | { t: 'response-done' }
  | { t: 'participants'; sessionId: string; participants: ThomasId[]; target?: ChatTarget }
  | { t: 'action'; speaker: ThomasId; detail: string }
  | { t: 'share-card'; speaker: ThomasId; card: ShareCard }
  | { t: 'ended'; speaker: ThomasId; reason?: string | null }
  | { t: 'error'; reason: string }
  | { t: 'close' };

// Human phrasing for when a prior conversation happened, for the "earlier —"
// divider. Deliberately coarse: the point is "this was a while ago", not a
// timestamp.
function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'previously';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? 'about a month ago' : `about ${months} months ago`;
}

let lineSeq = 0;
const nextId = () => `cl-${Date.now()}-${lineSeq++}`;

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case 'target':
      // Open (or retarget to) an agent — fresh idle session, no network yet.
      return { ...INITIAL, phase: 'idle', target: a.target, participants: [a.target.npcId] };

    case 'visitor-line':
      return {
        ...state,
        phase: state.phase === 'idle' ? 'live' : state.phase,
        hadSession: true,
        pendingReplies: state.pendingReplies + 1,
        lines: [...state.lines, { id: nextId(), kind: 'visitor', speaker: 'visitor', text: a.text }],
      };

    case 'history': {
      // Prepend, never append: this is what came BEFORE. Arrives asynchronously,
      // so the visitor may already have typed — their line must stay last.
      if (state.historyLoaded || a.lines.length === 0) return state;
      return { ...state, historyLoaded: true, lines: [...a.lines, ...state.lines] };
    }

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
      if (idx === -1) {
        return {
          ...state,
          streamingSpeaker: null,
        };
      }
      const lines = state.lines.slice();
      lines[idx] = { ...lines[idx], streaming: false };
      return {
        ...state,
        streamingSpeaker: null,
        lines,
      };
    }

    case 'response-done':
      return { ...state, pendingReplies: Math.max(0, state.pendingReplies - 1) };

    case 'participants': {
      const departed = state.participants.filter((id) => !a.participants.includes(id));
      const lines = departed.reduce<ChatLine[]>(
        (next, id) => [
          ...next,
          {
            id: nextId(),
            kind: 'action',
            speaker: id,
            text: `${agentShortName(id)} stepped out of the room chat.`,
          },
        ],
        state.lines,
      );
      return {
        ...state,
        sessionId: a.sessionId,
        participants: a.participants,
        target: a.target ?? state.target,
        lines,
      };
    }

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
        pendingReplies: 0,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'ended', text: endedLine(a.speaker, a.reason) },
        ],
      };

    case 'error':
      return {
        ...state,
        pendingReplies: Math.max(0, state.pendingReplies - 1),
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
  if (reason === 'engaged') return "They're with another visitor right now. Try again in a bit.";
  if (reason === 'room-full') return 'This room chat already has two facets in it.';
  if (reason === 'not-connected') return 'The town is still waking up. Try again in a moment.';
  if (reason === 'not-co-located') return 'You stepped away. Walk back to them to continue talking.';
  if (reason === 'sleeping')
    return "They're asleep right now — read the Chronicle to see today, and come back when the town wakes.";
  return 'The town is quiet right now. Try again shortly.';
}

export function ChatSession({ onSend, onClose, onAddress, suspended, currentLocation }: ChatSessionProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const statuses = useAgentStatuses();

  // Stable refs the EventBus / key closures read without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
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
      // Switching facets tears down the browser stream, while the model turn
      // continues server-side. Wait for every queued reply so none becomes an
      // orphaned response after its session is closed.
      if (s.pendingReplies > 0) return;
      // A live room keeps its shared transcript: addressing another co-located
      // facet either focuses an existing member or asks WorldClient to join it.
      if (s.phase === 'live' && s.hadSession) {
        onAddress(p.npcId);
        return;
      }
      if (s.phase === 'ended') {
        onClose(s.target?.npcId ?? null, s.hadSession);
      }
      const activity = statusLine(statusesRef.current[p.npcId]);
      dispatch({ t: 'target', target: { npcId: p.npcId, npcName: p.npcName, activity } });
    };

    // Proximity-exit no longer closes the panel — walking away is allowed; the
    // session keeps streaming. (Only ESC / × / chat_ended close it.)

    // Guard: drop chat-* stream events while closed (a frame racing a close).
    const live = (sessionId?: string) => {
      const current = stateRef.current;
      return (
        current.phase !== 'closed' &&
        (!sessionId || current.sessionId === sessionId)
      );
    };

    const onTurnStarted = (p: { npcId: ThomasId; sessionId: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'turn-started', speaker: p.npcId });
    };
    const onDelta = (p: { npcId: ThomasId; sessionId: string; text: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'delta', speaker: p.npcId, text: p.text });
    };
    const onMemory = (p: { npcId: ThomasId; sessionId: string; label: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'memory', speaker: p.npcId, label: p.label });
    };
    const onTurnDone = (p: { npcId: ThomasId; sessionId: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'turn-done', speaker: p.npcId });
    };
    const onResponseDone = (p: { sessionId: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'response-done' });
    };
    const onParticipants = (p: { sessionId: string; participants: ThomasId[]; addressed?: ThomasId }) => {
      const current = stateRef.current;
      if (
        current.phase === 'closed' ||
        (current.sessionId !== null && current.sessionId !== p.sessionId)
      ) return;
      const addressed = p.addressed;
      const target = addressed
        ? {
            npcId: addressed,
            npcName: NPC_CONFIGS[addressed]?.displayName ?? `${agentShortName(addressed)} Thomas`,
            activity: statusLine(statusesRef.current[addressed]),
          }
        : undefined;
      dispatch({ t: 'participants', sessionId: p.sessionId, participants: p.participants, target });
    };
    const onAction = (p: { npcId: ThomasId; sessionId: string; detail: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'action', speaker: p.npcId, detail: p.detail });
    };
    const onShareCard = (p: { npcId: ThomasId; sessionId: string; card: ShareCard }) => {
      if (live(p.sessionId)) dispatch({ t: 'share-card', speaker: p.npcId, card: p.card });
    };
    const onEnded = (p: { npcId: ThomasId; sessionId: string; reason?: string | null }) => {
      if (live(p.sessionId)) dispatch({ t: 'ended', speaker: p.npcId, reason: p.reason ?? null });
    };
    const onError = (p: { sessionId?: string; reason: string }) => {
      if (live(p.sessionId)) dispatch({ t: 'error', reason: p.reason });
    };
    const onTypingFocus = (p: { focused: boolean }) => {
      focusedRef.current = p.focused;
    };

    // Prior conversation with this facet, fetched by WorldClient right after the
    // session opens. Rendered above the live transcript behind an "earlier"
    // divider so the visitor picks up where they left off — the agent already
    // remembers them, and now the panel does too.
    const onHistory = (p: {
      npcId: ThomasId;
      messages: { sender: 'visitor' | ThomasId; text: string; timestamp: number }[];
      lastAt: string | null;
    }) => {
      const s = stateRef.current;
      if (s.phase === 'closed' || s.target?.npcId !== p.npcId) return;
      const lines: ChatLine[] = [
        {
          id: nextId(),
          kind: 'system',
          text: p.lastAt ? `earlier — ${relativeDay(p.lastAt)}` : 'earlier',
          historical: true,
        },
        ...p.messages.map((m) => ({
          id: nextId(),
          kind: (m.sender === 'visitor' ? 'visitor' : 'agent') as ChatLine['kind'],
          speaker: m.sender,
          text: m.text,
          historical: true,
        })),
        { id: nextId(), kind: 'system' as const, text: 'now', historical: true },
      ];
      dispatch({ t: 'history', lines });
    };

    EventBus.on('npc-interaction', onInteraction);
    EventBus.on('chat-history', onHistory);
    EventBus.on('chat-turn-started', onTurnStarted);
    EventBus.on('chat-delta', onDelta);
    EventBus.on('chat-memory-recalled', onMemory);
    EventBus.on('chat-turn-done', onTurnDone);
    EventBus.on('chat-response-done', onResponseDone);
    EventBus.on('chat-participants', onParticipants);
    EventBus.on('chat-action', onAction);
    EventBus.on('chat-share-card', onShareCard);
    EventBus.on('chat-ended', onEnded);
    EventBus.on('chat-error', onError);
    EventBus.on('typing-focus', onTypingFocus);

    return () => {
      EventBus.off('npc-interaction', onInteraction);
      EventBus.off('chat-history', onHistory);
      EventBus.off('chat-turn-started', onTurnStarted);
      EventBus.off('chat-delta', onDelta);
      EventBus.off('chat-memory-recalled', onMemory);
      EventBus.off('chat-turn-done', onTurnDone);
      EventBus.off('chat-response-done', onResponseDone);
      EventBus.off('chat-participants', onParticipants);
      EventBus.off('chat-action', onAction);
      EventBus.off('chat-share-card', onShareCard);
      EventBus.off('chat-ended', onEnded);
      EventBus.off('chat-error', onError);
      EventBus.off('typing-focus', onTypingFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onAddress, bumpFocus]);

  // Co-located nonmembers are invitation candidates, never implicit transcript
  // participants. Ambient room speech stays on the canvas.
  const available = useMemo(() => {
    if (!currentLocation || state.phase !== 'live' || !state.sessionId) return [] as ThomasId[];
    const roomIsHere = state.participants.every(
      (id) => statuses[id]?.locationId === currentLocation,
    );
    if (!roomIsHere) return [] as ThomasId[];
    return (Object.keys(statuses) as ThomasId[]).filter((id) => {
      const st = statuses[id];
      return !state.participants.includes(id) && !!st && st.locationId === currentLocation;
    });
  }, [statuses, currentLocation, state.phase, state.sessionId, state.participants]);

  // Tap a present facet → address them in the live room (joining explicitly if
  // needed); before the first send the same interaction simply changes target.
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
      participants={state.participants}
      available={available}
      onAddress={handleAddress}
      pendingReplies={state.pendingReplies}
    />
  );
}

// Tiny force-render hook for the imperative focus bump (focusNonce lives in a
// ref so the EventBus closures stay stable; this re-renders to push it down).
function useForceRender(): [number, () => void] {
  const [n, setN] = useReducer((x: number) => x + 1, 0);
  return [n, setN as unknown as () => void];
}
