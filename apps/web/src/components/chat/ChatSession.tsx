import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import type { AgentId, LocationId } from '@town/contract';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';
import { agentColor, agentFullName } from './primitives';
import { DiegeticDialog } from './DiegeticDialog';
import { DockedPanel } from './DockedPanel';
import type { BusyAlternative, ChatLine, ChatTarget, ChatTier } from './types';

// ── The one persistent ChatSession container (design doc §1 + §6.3) ──────────
//
// ONE mounted component owns the sessionId / message list / active stream. It
// renders TWO CSS presentations of that single state — Tier 1 diegetic dialog
// (bottom-center pixel frame) and Tier 2 docked panel (right rail) — and the
// busy-409 alternatives surface. Escalation between tiers is a state flip, not
// an unmount: the in-flight stream survives because the React subtree (and its
// EventBus subscriptions) never tears down.
//
// Two-step greeting gate: the first interact-press opens the dialog LOCALLY and
// free (agent name + live activity from the snapshot, zero network); the second
// intent (re-press or first keystroke) calls WorldClient.openChat → POST /chats
// + /open, which streams the agent-initiated greeting. Walk-away / ESC closes;
// it only tells the server to close a session that was actually opened.

interface ChatSessionProps {
  // WorldClient seam — the container drives the session through these.
  onOpen: (npcId: ThomasId) => void; // POST /chats + stream greeting
  onSend: (npcId: ThomasId, text: string) => void; // POST /chats/:id/messages
  onClose: (npcId: ThomasId | null, opened: boolean) => void; // POST /chats/:id/close (if opened)
  onListenIn: (alt: BusyAlternative) => void; // travel + transcript strip (busy scene path)
  // Scene context so the busy path can resolve a co-located scene to listen in on.
  currentLocationId: LocationId | null;
  // Live scenes (from App) keyed by conversationId — used to resolve a busy
  // agent's scene into an actionable [listen in] target.
  liveScenes: Record<string, { conversationId: string; location: LocationId; participants: ThomasId[] }>;
}

// ── reducer state ────────────────────────────────────────────────────────────
type Phase = 'closed' | 'gate' | 'opening' | 'live' | 'busy';

interface State {
  phase: Phase;
  tier: ChatTier;
  target: ChatTarget | null;
  lines: ChatLine[];
  // The speaker whose turn is currently streaming (null between turns).
  streamingSpeaker: ThomasId | null;
  suggestedReplies: string[];
  busy: BusyAlternative | null;
  // True once we actually told the server to open (POST /chats fired) — gates
  // whether close needs a network teardown.
  opened: boolean;
}

const INITIAL: State = {
  phase: 'closed',
  tier: 'diegetic',
  target: null,
  lines: [],
  streamingSpeaker: null,
  suggestedReplies: [],
  busy: null,
  opened: false,
};

type Action =
  | { t: 'open-gate'; target: ChatTarget }
  | { t: 'begin-open' }
  | { t: 'escalate' }
  | { t: 'visitor-line'; text: string }
  | { t: 'turn-started'; speaker: ThomasId }
  | { t: 'delta'; speaker: ThomasId; text: string }
  | { t: 'memory'; speaker: ThomasId; label: string }
  | { t: 'turn-done'; speaker: ThomasId }
  | { t: 'suggested'; replies: string[] }
  | { t: 'joined'; speaker: ThomasId }
  | { t: 'error'; reason: string; busy: BusyAlternative | null }
  | { t: 'close' };

let lineSeq = 0;
const nextId = () => `cl-${Date.now()}-${lineSeq++}`;

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case 'open-gate':
      return { ...INITIAL, phase: 'gate', target: a.target };

    case 'begin-open':
      if (state.phase !== 'gate' || !state.target) return state;
      return { ...state, phase: 'opening', opened: true };

    case 'escalate':
      return { ...state, tier: 'docked' };

    case 'visitor-line':
      return {
        ...state,
        suggestedReplies: [],
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
      // Append to the open streaming bubble for this speaker. If none exists
      // (a delta arrived before turn_started — e.g. the greeting), open one.
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

    case 'suggested':
      return { ...state, suggestedReplies: a.replies };

    case 'joined':
      return {
        ...state,
        lines: [
          ...state.lines,
          {
            id: nextId(),
            kind: 'system',
            text: `${agentFullName(a.speaker).replace('Thomas', '').trim()} joined the conversation`,
          },
        ],
      };

    case 'error':
      // An engagement 409 lands here with resolved alternatives → busy surface.
      if (a.busy) return { ...state, phase: 'busy', busy: a.busy, opened: false };
      // Other errors surface as a system line in whatever tier we're in.
      return {
        ...state,
        phase: state.phase === 'opening' ? 'gate' : state.phase,
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

function errorLine(reason: string): string {
  if (reason === 'join-lost-race') return 'Someone else jumped in first — you can still listen in.';
  if (reason === 'mid-thought')
    return 'Deep in thought right now — give it a few seconds and press again.';
  if (reason === 'not-connected') return 'The town is still waking up. Try again in a moment.';
  if (reason === 'sleeping')
    return "They're asleep right now — read the feed to see today, and come back when the town wakes.";
  return 'The town is quiet right now. Try again shortly.';
}

export function ChatSession({
  onOpen,
  onSend,
  onClose,
  onListenIn,
  currentLocationId,
  liveScenes,
}: ChatSessionProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const statuses = useAgentStatuses();

  // Stable refs the EventBus closures read without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const scenesRef = useRef(liveScenes);
  scenesRef.current = liveScenes;
  const locRef = useRef(currentLocationId);
  locRef.current = currentLocationId;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  // Resolve a busy 409 into an actionable alternative using live agent status +
  // known scenes. Scene engagement → [listen in]; chat engagement → profile rail.
  const resolveBusy = useCallback((npcId: ThomasId): BusyAlternative => {
    const eng = statusesRef.current[npcId]?.engagement;
    if (eng?.kind === 'scene') {
      // Find the live scene this agent is in (by participant), if we know it.
      const scene = Object.values(scenesRef.current).find((s) => s.participants.includes(npcId));
      return {
        kind: 'scene',
        conversationId: scene?.conversationId,
        location: scene?.location,
        participants: scene?.participants as AgentId[] | undefined,
      };
    }
    return { kind: 'chat' };
  }, []);

  // ── EventBus wiring (one subscription block; stable handlers) ──────────────
  useEffect(() => {
    // The interact press drives the two-step gate. First press for an agent
    // opens the gate locally; a second press for the SAME agent (still in the
    // gate) spends the open. A press for a different agent re-targets the gate.
    const onInteraction = (p: { npcId: ThomasId; npcName: string }) => {
      const s = stateRef.current;
      if (s.phase === 'gate' && s.target?.npcId === p.npcId) {
        beginOpen();
        return;
      }
      if (s.phase === 'live' || s.phase === 'opening') {
        // Already talking to this agent — a re-press is a no-op; a different
        // agent means the visitor walked off mid-chat, handled by close.
        if (s.target?.npcId === p.npcId) return;
      }
      const activity = statusLine(statusesRef.current[p.npcId]);
      dispatch({ t: 'open-gate', target: { npcId: p.npcId, npcName: p.npcName, activity } });
    };

    const onProximityExit = (p: { npcId: ThomasId }) => {
      const s = stateRef.current;
      // Walk away from an UN-GREETED gate → close it (it cost nothing). An open
      // conversation survives walk-away (the stream keeps going).
      if (s.phase === 'gate' && s.target?.npcId === p.npcId) {
        doClose();
      }
    };

    const onTurnStarted = (p: { npcId: ThomasId }) => dispatch({ t: 'turn-started', speaker: p.npcId });
    const onDelta = (p: { npcId: ThomasId; text: string }) =>
      dispatch({ t: 'delta', speaker: p.npcId, text: p.text });
    const onMemory = (p: { npcId: ThomasId; label: string }) =>
      dispatch({ t: 'memory', speaker: p.npcId, label: p.label });
    const onTurnDone = (p: { npcId: ThomasId }) => dispatch({ t: 'turn-done', speaker: p.npcId });
    const onSuggested = (p: { replies: string[] }) => dispatch({ t: 'suggested', replies: p.replies });
    const onJoined = (p: { npcId: ThomasId }) => dispatch({ t: 'joined', speaker: p.npcId });
    const onError = (p: { npcId?: ThomasId; reason: string }) => {
      const busy = p.reason === 'engaged' && p.npcId ? resolveBusy(p.npcId) : null;
      dispatch({ t: 'error', reason: p.reason, busy });
    };

    EventBus.on('npc-interaction', onInteraction);
    EventBus.on('npc-proximity-exit', onProximityExit);
    EventBus.on('chat-turn-started', onTurnStarted);
    EventBus.on('chat-delta', onDelta);
    EventBus.on('chat-memory-recalled', onMemory);
    EventBus.on('chat-turn-done', onTurnDone);
    EventBus.on('chat-suggested-replies', onSuggested);
    EventBus.on('chat-joined', onJoined);
    EventBus.on('chat-error', onError);

    return () => {
      EventBus.off('npc-interaction', onInteraction);
      EventBus.off('npc-proximity-exit', onProximityExit);
      EventBus.off('chat-turn-started', onTurnStarted);
      EventBus.off('chat-delta', onDelta);
      EventBus.off('chat-memory-recalled', onMemory);
      EventBus.off('chat-turn-done', onTurnDone);
      EventBus.off('chat-suggested-replies', onSuggested);
      EventBus.off('chat-joined', onJoined);
      EventBus.off('chat-error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── intent handlers ────────────────────────────────────────────────────────
  const beginOpen = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== 'gate' || !s.target) return;
    dispatch({ t: 'begin-open' });
    // The chat is actually engaging now — freeze player movement (canvas pause)
    // and lock the sprite facing the player. The free gate (pre-engage) emits
    // npc-interaction only, so walking away from it stays possible.
    EventBus.emit('chat-opened', { npcId: s.target.npcId });
    onOpen(s.target.npcId);
  }, [onOpen]);

  const doClose = useCallback(() => {
    const s = stateRef.current;
    onClose(s.target?.npcId ?? null, s.opened);
    dispatch({ t: 'close' });
  }, [onClose]);

  const handleSend = useCallback(
    (text: string) => {
      const s = stateRef.current;
      const t = text.trim();
      if (!t || !s.target) return;
      // Typing in the gate is the second intent — open first, then send once the
      // session exists. WorldClient queues the message after /open resolves.
      if (s.phase === 'gate') beginOpen();
      dispatch({ t: 'visitor-line', text: t });
      onSend(s.target.npcId, t);
    },
    [beginOpen, onSend]
  );

  const handleEscalate = useCallback(() => dispatch({ t: 'escalate' }), []);

  const handleListenIn = useCallback(() => {
    const s = stateRef.current;
    if (s.busy) onListenIn(s.busy);
    dispatch({ t: 'close' });
  }, [onListenIn]);

  // Global ESC closes the session (only a server-opened one tears down).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stateRef.current.phase !== 'closed') doClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doClose]);

  const liveStatus = state.target ? statuses[state.target.npcId] : undefined;
  const color = useMemo(
    () => (state.target ? agentColor(state.target.npcId) : 'var(--career)'),
    [state.target]
  );

  if (state.phase === 'closed' || !state.target) return null;

  const shared = {
    target: state.target,
    color,
    lines: state.lines,
    streamingSpeaker: state.streamingSpeaker,
    suggestedReplies: state.suggestedReplies,
    phase: state.phase,
    busy: state.busy,
    liveActivity: liveStatus ? statusLine(liveStatus) : state.target.activity,
    onSend: handleSend,
    onEscalate: handleEscalate,
    onClose: doClose,
    onListenIn: handleListenIn,
  };

  // Tier 2 = docked panel; everything else (gate / opening / live diegetic /
  // busy) renders as the bottom-center diegetic dialog. The two never coexist —
  // it's one container picking a presentation, so the stream survives the morph.
  return state.tier === 'docked' ? <DockedPanel {...shared} /> : <DiegeticDialog {...shared} />;
}
