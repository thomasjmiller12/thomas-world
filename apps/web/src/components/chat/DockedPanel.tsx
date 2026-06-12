import { useEffect, useRef, useState } from 'react';
import type { ThomasId } from '@/lib/types';
import type { BusyAlternative, ChatLine, ChatTarget } from './types';
import {
  Bubble,
  SpritePortrait,
  StatusDot,
  StreamDots,
  agentColor,
  agentShortName,
} from './primitives';
import { fetchRecentRows, type RailRow } from './recentEvents';

// Tier-2 docked panel (design doc §1 Tier 2 + §6.3, handoff ChatDocked): the
// richest continuity carrier. ~368px right rail on paper-2, with the agent
// header, the "BEFORE YOU WALKED IN" rail, the full streaming conversation
// (color-attributed bubbles + memory chips), suggested-reply chips, and the
// input row. Same ChatSession state as the diegetic tier — escalation just
// flips which presentation renders, so the in-flight stream never drops.

interface Props {
  target: ChatTarget;
  color: string;
  lines: ChatLine[];
  streamingSpeaker: ThomasId | null;
  suggestedReplies: string[];
  phase: 'gate' | 'opening' | 'live' | 'busy';
  busy: BusyAlternative | null;
  liveActivity: string;
  onSend: (text: string) => void;
  onEscalate: () => void;
  onClose: () => void;
  onListenIn: () => void;
}

export function DockedPanel({
  target,
  color,
  lines,
  streamingSpeaker,
  suggestedReplies,
  phase,
  liveActivity,
  onSend,
  onClose,
}: Props) {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<RailRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pull the "before you walked in" rail once per agent (best-effort).
  useEffect(() => {
    let live = true;
    void fetchRecentRows(target.npcId).then((r) => {
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = (text: string) => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setInput('');
  };

  const generating = phase === 'opening' || (!!streamingSpeaker && lines.some((l) => l.streaming));

  return (
    <div
      className="pointer-events-auto"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        // Rail on desktop; full-screen overlay on a narrow viewport (panel
        // coexistence rule, design §6.3) — min() caps it to the screen width.
        width: 'min(368px, 100vw)',
        background: 'var(--paper-2)',
        borderLeft: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-20px 0 50px -30px rgba(0,0,0,.5)',
        animation: 'slideInRight 0.22s ease-out',
        fontFamily: 'var(--sans)',
        zIndex: 40,
      }}
    >
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '15px 16px',
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
          }}
        >
          <SpritePortrait npcId={target.npcId} scale={1.4} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 16px var(--display)', color: 'var(--ink)' }}>
            {agentShortName(target.npcId)} Thomas
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

      {/* before-you-walked-in rail */}
      {rows.length > 0 && (
        <div style={{ padding: '13px 16px', background: `${color}0b`, borderBottom: '1px solid var(--line)' }}>
          <div
            style={{
              font: '700 9.5px var(--mono)',
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              marginBottom: 10,
            }}
          >
            Before you walked in
          </div>
          <div style={{ position: 'relative', paddingLeft: 2 }}>
            {rows.map((e, i) => (
              <div
                key={e.id}
                style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: i < rows.length - 1 ? 10 : 0 }}
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
        </div>
      )}

      {/* conversation */}
      <div ref={scrollRef} style={{ flex: 1, padding: '15px 16px 4px', overflowY: 'auto' }}>
        {lines.map((line) => {
          if (line.kind === 'system') {
            return (
              <div
                key={line.id}
                style={{
                  textAlign: 'center',
                  font: '600 10px var(--mono)',
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  margin: '6px 0 12px',
                }}
              >
                {line.text}
              </div>
            );
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

      {/* suggested replies */}
      {suggestedReplies.length > 0 && (
        <div style={{ display: 'flex', gap: 7, padding: '4px 16px 10px', flexWrap: 'wrap' }}>
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

      {/* input row */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px 14px', borderTop: '1px solid var(--line)' }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend(input)}
          placeholder="Say something…"
          style={{
            flex: 1,
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
    </div>
  );
}
