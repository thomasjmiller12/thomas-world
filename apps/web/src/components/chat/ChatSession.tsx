import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';
import { locationLabel } from '@/components/chronicle/chroniclePresentation';
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
}

// ── reducer state ────────────────────────────────────────────────────────────
type Phase = 'closed' | 'idle' | 'live' | 'ended';

interface State {
  phase: Phase;
  target: ChatTarget | null;
  lines: ChatLine[];
  // The speaker whose turn is currently streaming (null between turns).
  streamingSpeaker: ThomasId | null;
  suggestedReplies: string[];
  // True once a message was sent (a server session exists) — gates whether
  // close needs a network teardown.
  hadSession: boolean;
}

const INITIAL: State = {
  phase: 'closed',
  target: null,
  lines: [],
  streamingSpeaker: null,
  suggestedReplies: [],
  hadSession: false,
};

type Action =
  | { t: 'target'; target: ChatTarget }
  | { t: 'visitor-line'; text: string }
  | { t: 'turn-started'; speaker: ThomasId }
  | { t: 'delta'; speaker: ThomasId; text: string }
  | { t: 'memory'; speaker: ThomasId; label: string }
  | { t: 'turn-done'; speaker: ThomasId }
  | { t: 'suggested'; replies: string[] }
  | { t: 'action'; speaker: ThomasId; detail: string }
  | { t: 'ended'; speaker: ThomasId }
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

    case 'suggested':
      return { ...state, suggestedReplies: a.replies };

    case 'action':
      // The agent acted mid-chat — a centered diegetic line.
      return {
        ...state,
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'action', speaker: a.speaker, text: a.detail },
        ],
      };

    case 'ended':
      // The agent ended the chat itself — a goodbye system line; the input row
      // becomes a [wave goodbye] close button.
      return {
        ...state,
        phase: 'ended',
        streamingSpeaker: null,
        suggestedReplies: [],
        lines: [
          ...state.lines,
          { id: nextId(), kind: 'ended', text: endedLine(a.speaker) },
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

function endedLine(speaker: ThomasId): string {
  return `${agentShortName(speaker)} headed back to work.`;
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

export function ChatSession({ onSend, onClose, suspended }: ChatSessionProps) {
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
      if (live()) dispatch({ t: 'turn-started', speaker: p.npcId });
    };
    const onDelta = (p: { npcId: ThomasId; text: string }) => {
      if (live()) dispatch({ t: 'delta', speaker: p.npcId, text: p.text });
    };
    const onMemory = (p: { npcId: ThomasId; label: string }) => {
      if (live()) dispatch({ t: 'memory', speaker: p.npcId, label: p.label });
    };
    const onTurnDone = (p: { npcId: ThomasId }) => {
      if (live()) dispatch({ t: 'turn-done', speaker: p.npcId });
    };
    const onSuggested = (p: { replies: string[] }) => {
      if (live()) dispatch({ t: 'suggested', replies: p.replies });
    };
    const onAction = (p: { npcId: ThomasId; detail: string }) => {
      if (live()) dispatch({ t: 'action', speaker: p.npcId, detail: p.detail });
    };
    const onEnded = (p: { npcId: ThomasId }) => {
      if (live()) dispatch({ t: 'ended', speaker: p.npcId });
    };
    const onError = (p: { reason: string }) => {
      if (live()) dispatch({ t: 'error', reason: p.reason });
    };
    const onTypingFocus = (p: { focused: boolean }) => {
      focusedRef.current = p.focused;
    };

    EventBus.on('npc-interaction', onInteraction);
    EventBus.on('chat-turn-started', onTurnStarted);
    EventBus.on('chat-delta', onDelta);
    EventBus.on('chat-memory-recalled', onMemory);
    EventBus.on('chat-turn-done', onTurnDone);
    EventBus.on('chat-suggested-replies', onSuggested);
    EventBus.on('chat-action', onAction);
    EventBus.on('chat-ended', onEnded);
    EventBus.on('chat-error', onError);
    EventBus.on('typing-focus', onTypingFocus);

    return () => {
      EventBus.off('npc-interaction', onInteraction);
      EventBus.off('chat-turn-started', onTurnStarted);
      EventBus.off('chat-delta', onDelta);
      EventBus.off('chat-memory-recalled', onMemory);
      EventBus.off('chat-turn-done', onTurnDone);
      EventBus.off('chat-suggested-replies', onSuggested);
      EventBus.off('chat-action', onAction);
      EventBus.off('chat-ended', onEnded);
      EventBus.off('chat-error', onError);
      EventBus.off('typing-focus', onTypingFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, bumpFocus]);

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
      suggestedReplies={state.suggestedReplies}
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
    />
  );
}

// Tiny force-render hook for the imperative focus bump (focusNonce lives in a
// ref so the EventBus closures stay stable; this re-renders to push it down).
function useForceRender(): [number, () => void] {
  const [n, setN] = useReducer((x: number) => x + 1, 0);
  return [n, setN as unknown as () => void];
}
