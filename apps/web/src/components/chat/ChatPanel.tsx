import { useEffect, useRef, useState } from 'react';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import type { ChatLine, ChatTarget } from './types';
import {
  Bubble,
  SpritePortrait,
  StatusDot,
  StreamDots,
  agentColor,
  agentShortName,
} from './primitives';
import { fetchRecentRows, type RailRow } from './recentEvents';

// ChatPanel — the ONE chat presentation (M2.1, replaces DiegeticDialog +
// DockedPanel). A side-docked popup card the world stays visible + navigable
// around: the visitor can walk while it streams. On a narrow viewport it
// becomes a bottom sheet that sits above the mobile keyboard.
//
// Phases (driven by ChatSession's reducer):
//   idle  — opened locally + free; no session yet. Shows a LATELY context strip.
//   live  — a session exists; the transcript + input row are active.
//   ended — the agent ended the chat; the input is replaced by a close button.
//
// The visitor speaks first (no greeting). The panel emits `typing-focus` on the
// input's focus/blur so the player freezes ONLY while typing — and MUST emit
// {focused:false} on unmount (StrictMode/close) so movement is never left frozen.

const NARROW_BREAKPOINT = 720;

interface ChatPanelProps {
  target: ChatTarget;
  color: string;
  lines: ChatLine[];
  streamingSpeaker: ThomasId | null;
  suggestedReplies: string[];
  phase: 'idle' | 'live' | 'ended';
  // Live activity line (from useAgentStatuses) — updates as the agent moves
  // mid-chat.
  liveActivity: string;
  onSend: (text: string) => void;
  onClose: () => void;
  // Imperative focus request from the parent (Enter / SPACE refocus). A bumped
  // counter re-runs the focus effect.
  focusNonce: number;
}

export function ChatPanel({
  target,
  color,
  lines,
  streamingSpeaker,
  suggestedReplies,
  phase,
  liveActivity,
  onSend,
  onClose,
  focusNonce,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [rows, setRows] = useState<RailRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Track the narrow breakpoint for the bottom-sheet layout (SSR-safe).
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < NARROW_BREAKPOINT);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Pull the "LATELY" context strip once per agent (best-effort).
  useEffect(() => {
    let live = true;
    void fetchRecentRows(target.npcId, 3).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [target.npcId]);

  // Auto-follow the transcript as turns stream.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, suggestedReplies]);

  // Autofocus on open and on an imperative refocus (Enter / SPACE).
  useEffect(() => {
    if (phase !== 'ended') inputRef.current?.focus();
  }, [focusNonce, phase]);

  // Unmount cleanup: the input may have been focused when the panel tore down,
  // so explicitly release the player freeze — the blur event doesn't fire
  // reliably on unmount / under StrictMode, and a stuck freeze is unrecoverable.
  useEffect(() => {
    return () => {
      EventBus.emit('typing-focus', { focused: false });
    };
  }, []);

  const handleSend = (text: string) => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setInput('');
  };

  const short = agentShortName(target.npcId);
  const generating = !!streamingSpeaker && lines.some((l) => l.streaming);
  // The context strip only reads while we haven't started talking.
  const showLately = phase === 'idle' && rows.length > 0;

  const card: React.CSSProperties = narrow
    ? {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '48vh',
        maxHeight: '48dvh',
        borderRadius: '16px 16px 0 0',
        animation: 'slideUpSheet 0.22s ease-out',
      }
    : {
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 'min(392px, calc(100vw - 32px))',
        maxHeight: 'min(72vh, 640px)',
        borderRadius: 16,
        animation: 'slideInRight 0.22s ease-out',
      };

  return (
    <div
      className="pointer-events-auto"
      style={{
        ...card,
        background: 'var(--paper-2)',
        boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--sans)',
        zIndex: 40,
      }}
    >
      {/* mobile drag-handle bar */}
      {narrow && (
        <div style={{ display: 'grid', placeItems: 'center', padding: '7px 0 2px' }}>
          <div style={{ width: 38, height: 4, borderRadius: 99, background: 'var(--line-2)' }} />
        </div>
      )}

      {/* header — portrait, short name, live activity, close */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '13px 14px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            background: `${color}1f`,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <SpritePortrait npcId={target.npcId} scale={1.4} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 16px var(--display)', color: 'var(--ink)' }}>
            {short} Thomas
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <StatusDot color={color} size={7} />
            <span
              style={{
                font: '500 10px var(--mono)',
                letterSpacing: '.03em',
                textTransform: 'uppercase',
                color: 'var(--ink-2)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {liveActivity}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--ink-3)',
            fontSize: 18,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      {/* LATELY context strip (idle only) */}
      {showLately && (
        <div style={{ padding: '11px 14px', background: `${color}0b`, borderBottom: '1px solid var(--line)' }}>
          <div
            style={{
              font: '700 9px var(--mono)',
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              marginBottom: 9,
            }}
          >
            Lately
          </div>
          {rows.map((e, i) => (
            <div
              key={e.id}
              style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: i < rows.length - 1 ? 9 : 0 }}
            >
              <div style={{ fontSize: 13, width: 18, textAlign: 'center' }}>{e.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    font: '700 8.5px var(--mono)',
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    color: 'var(--ink-3)',
                    marginBottom: 2,
                  }}
                >
                  {e.label}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.4 }}>{e.line}</div>
              </div>
              {e.time && (
                <div style={{ font: '500 10px var(--mono)', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                  {e.time}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* transcript */}
      <div ref={scrollRef} style={{ flex: 1, padding: '15px 14px 4px', overflowY: 'auto' }}>
        {phase === 'idle' && lines.length === 0 && !showLately && (
          <p style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.5, margin: 0 }}>
            Say something to {short} Thomas to start a conversation.
          </p>
        )}
        {lines.map((line) => {
          if (line.kind === 'system') {
            return <SystemLine key={line.id} text={line.text} silkscreen={false} />;
          }
          if (line.kind === 'ended') {
            return <SystemLine key={line.id} text={line.text} silkscreen />;
          }
          if (line.kind === 'action') {
            const c = line.speaker && line.speaker !== 'visitor' ? agentColor(line.speaker) : color;
            return <ActionLine key={line.id} text={line.text} color={c} />;
          }
          const isAgent = line.kind === 'agent';
          const speaker = line.speaker as ThomasId | undefined;
          return (
            <Bubble
              key={line.id}
              side={isAgent ? 'agent' : 'visitor'}
              color={isAgent && speaker ? agentColor(speaker) : undefined}
              name={isAgent && speaker ? `${agentShortName(speaker)} Thomas` : undefined}
              memory={line.memory}
            >
              {line.text}
            </Bubble>
          );
        })}
        {generating && <StreamDots color={streamingSpeaker ? agentColor(streamingSpeaker) : color} />}
      </div>

      {/* suggested replies (hidden once the chat has ended) */}
      {phase !== 'ended' && suggestedReplies.length > 0 && (
        <div style={{ display: 'flex', gap: 7, padding: '4px 14px 10px', flexWrap: 'wrap' }}>
          {suggestedReplies.map((q) => (
            <button
              key={q}
              onClick={() => handleSend(q)}
              style={{
                padding: '6px 11px',
                borderRadius: 999,
                border: `1px solid ${color}40`,
                color,
                fontSize: 12,
                fontWeight: 600,
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* input row, or the [wave goodbye] close button once ended */}
      {phase === 'ended' ? (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--line)' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '11px 0',
              borderRadius: 11,
              border: 'none',
              background: color,
              color: '#fff',
              font: '600 13.5px var(--display)',
              cursor: 'pointer',
            }}
          >
            wave goodbye
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px 14px', borderTop: '1px solid var(--line)' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend(input);
            }}
            onFocus={() => EventBus.emit('typing-focus', { focused: true })}
            onBlur={() => EventBus.emit('typing-focus', { focused: false })}
            placeholder={`say something to ${short}…`}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '10px 13px',
              borderRadius: 11,
              background: '#fff',
              border: '1px solid var(--line)',
              color: 'var(--ink)',
              fontSize: 13.5,
              outline: 'none',
              fontFamily: 'var(--sans)',
            }}
          />
          <button
            onClick={() => handleSend(input)}
            style={{
              padding: '0 15px',
              borderRadius: 11,
              border: 'none',
              background: color,
              color: '#fff',
              font: '600 13.5px var(--display)',
              cursor: 'pointer',
            }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

// A centered system line. `silkscreen` => the Silkscreen pixel font (used for
// the agent-ended goodbye); otherwise the regular system style.
function SystemLine({ text, silkscreen }: { text: string; silkscreen: boolean }) {
  return (
    <div
      style={{
        textAlign: 'center',
        font: silkscreen ? '600 10px var(--mono)' : '600 10.5px var(--sans)',
        letterSpacing: silkscreen ? '.06em' : '.01em',
        textTransform: silkscreen ? 'uppercase' : 'none',
        color: 'var(--ink-3)',
        margin: '8px 0 12px',
      }}
    >
      {text}
    </div>
  );
}

// A centered diegetic action line ("*walks to the workbench*") — the agent
// acted mid-chat. Italic ink-3 with a small agent-hue glyph.
function ActionLine({ text, color }: { text: string; color: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        margin: '6px 0 12px',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontStyle: 'italic', fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.4 }}>
        {text}
      </span>
    </div>
  );
}
