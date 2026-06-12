import { useEffect, useRef, useState } from 'react';
import type { ThomasId } from '@/lib/types';
import type { BusyAlternative, ChatLine, ChatTarget } from './types';
import {
  SpritePortrait,
  StatusDot,
  agentColor,
  agentShortName,
  useTypewriter,
} from './primitives';

// Tier-1 diegetic RPG dialog (design doc §1, handoff ChatDiegetic): a pixel-
// frame panel docked bottom-center, with a portrait panel, an agent-color
// nameplate, typewriter streaming, and a one-line input. Also hosts the
// two-step greeting gate ("press again or start typing to talk") and the
// busy-409 actionable alternatives.

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

export function DiegeticDialog({
  target,
  color,
  lines,
  streamingSpeaker,
  suggestedReplies,
  phase,
  busy,
  liveActivity,
  onSend,
  onEscalate,
  onClose,
  onListenIn,
}: Props) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      onSend(input);
      setInput('');
    }
  };

  // The latest agent line drives the diegetic typewriter (a dialog box shows one
  // speaker's current line, RPG-style). The whole transcript lives in the docked
  // tier; here we surface the most recent agent turn + the gate/busy copy.
  const lastAgent = [...lines].reverse().find((l) => l.kind === 'agent');
  const greetingText = lastAgent?.text ?? '';
  const streaming = !!lastAgent?.streaming;

  return (
    <div
      className="pointer-events-auto"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 30,
        transform: 'translateX(-50%)',
        width: 760,
        maxWidth: '92%',
        animation: 'riseIn 0.22s ease-out',
        // The morph anchor: when escalating to docked, this container is swapped
        // for DockedPanel by the parent; both share state so the stream survives.
        transition: 'width 0.2s ease, bottom 0.2s ease',
        fontFamily: 'var(--sans)',
        zIndex: 40,
      }}
    >
      <div
        className="pixel-frame"
        style={{
          background: 'var(--paper-2)',
          position: 'relative',
          padding: '22px 24px 18px 152px',
          minHeight: 132,
        }}
      >
        {/* portrait panel */}
        <div style={{ position: 'absolute', left: 18, top: 18, bottom: 18, width: 116 }}>
          <div
            className="pixel-frame-inner"
            style={{
              width: 116,
              height: '100%',
              background: `${color}1a`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div style={{ transform: 'scale(2.4)' }}>
              <SpritePortrait npcId={target.npcId} scale={2.2} />
            </div>
          </div>
        </div>

        {/* agent-color nameplate */}
        <div
          style={{
            position: 'absolute',
            top: -15,
            left: 150,
            background: color,
            color: '#fff',
            font: '700 12px var(--mono)',
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            padding: '5px 13px',
            boxShadow: '4px 4px 0 rgba(36,26,16,.25)',
          }}
        >
          {agentShortName(target.npcId)} Thomas
        </div>

        {/* close affordance */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
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

        {phase === 'busy' && busy ? (
          <BusyBody
            target={target}
            color={color}
            busy={busy}
            liveActivity={liveActivity}
            onListenIn={onListenIn}
            onClose={onClose}
          />
        ) : phase === 'gate' ? (
          <GateBody color={color} liveActivity={liveActivity} />
        ) : (
          <LiveBody
            color={color}
            text={greetingText}
            streaming={streaming || phase === 'opening'}
            opening={phase === 'opening' && !greetingText}
            streamingSpeaker={streamingSpeaker}
          />
        )}

        {/* input row + escalate (hidden on the busy surface) */}
        {phase !== 'busy' && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              marginTop: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0 }}>
              <span style={{ color, fontWeight: 700 }}>▸</span>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder={`ask ${agentShortName(target.npcId)} Thomas…`}
                style={{
                  flex: 1,
                  maxWidth: 360,
                  padding: '9px 13px',
                  background: '#fff',
                  border: '2px solid var(--frame-ink)',
                  color: 'var(--ink)',
                  font: '400 13.5px var(--sans)',
                  outline: 'none',
                }}
              />
            </div>
            {(phase === 'live' || phase === 'opening') && (
              <button
                onClick={onEscalate}
                style={{
                  font: '700 12px var(--mono)',
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: 'var(--frame-ink)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                keep talking ▸
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The free first step: name + live activity, "press again or start typing".
function GateBody({ color, liveActivity }: { color: string; liveActivity: string }) {
  return (
    <div style={{ minHeight: 54 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot color={color} size={8} />
        <span
          style={{
            font: '500 10.5px var(--mono)',
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--ink-2)',
          }}
        >
          {liveActivity}
        </span>
      </div>
      <p style={{ fontSize: 16, lineHeight: 1.5, color: 'var(--frame-ink)', margin: 0 }}>
        <span style={{ color, fontWeight: 700 }}>Press again</span> or just start typing to talk.
      </p>
    </div>
  );
}

// The streaming agent line (typewriter). `opening` => the greeting POST is in
// flight, so show the animated dots until the first delta lands.
function LiveBody({
  color,
  text,
  streaming,
  opening,
  streamingSpeaker,
}: {
  color: string;
  text: string;
  streaming: boolean;
  opening: boolean;
  streamingSpeaker: ThomasId | null;
}) {
  const { shown, done } = useTypewriter(text, 22, streaming);
  return (
    <div style={{ fontSize: 18, lineHeight: 1.55, color: 'var(--frame-ink)', minHeight: 54 }}>
      {/* In a group session, a turn by the second agent shows their short name
          in their color (multi-party attribution). */}
      {streamingSpeaker && streaming && (
        <span
          style={{
            display: 'block',
            font: '700 10px var(--mono)',
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: agentColor(streamingSpeaker),
            marginBottom: 4,
          }}
        >
          {agentShortName(streamingSpeaker)}
        </span>
      )}
      {opening ? (
        <span style={{ color: 'var(--ink-3)' }}>
          <span style={{ animation: 'blink 1s steps(1) infinite' }}>…</span>
        </span>
      ) : (
        <>
          {shown}
          <span style={{ opacity: done ? 0 : 1, animation: 'blink 1s steps(1) infinite' }}>▌</span>
        </>
      )}
    </div>
  );
}

// The 409 actionable-alternatives surface (design doc §1 busy path).
function BusyBody({
  target,
  color,
  busy,
  liveActivity,
  onListenIn,
  onClose,
}: {
  target: ChatTarget;
  color: string;
  busy: BusyAlternative;
  liveActivity: string;
  onListenIn: () => void;
  onClose: () => void;
}) {
  const short = agentShortName(target.npcId);
  if (busy.kind === 'scene') {
    return (
      <div style={{ minHeight: 54 }}>
        <p style={{ fontSize: 16, lineHeight: 1.5, color: 'var(--frame-ink)', margin: '0 0 12px' }}>
          {short} is deep in conversation right now.
        </p>
        <button
          onClick={onListenIn}
          style={{
            font: '700 12px var(--mono)',
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: '#fff',
            background: color,
            border: 'none',
            padding: '8px 14px',
            cursor: 'pointer',
          }}
        >
          ⊕ listen in
        </button>
      </div>
    );
  }
  // chat engagement → profile rail ("he's with a visitor — here's what he's been up to")
  return (
    <div style={{ minHeight: 54 }}>
      <p style={{ fontSize: 16, lineHeight: 1.5, color: 'var(--frame-ink)', margin: '0 0 8px' }}>
        {short} is with another visitor.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot color={color} size={7} />
        <span
          style={{
            font: '500 10.5px var(--mono)',
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--ink-2)',
          }}
        >
          {liveActivity}
        </span>
      </div>
      <button
        onClick={onClose}
        style={{
          marginTop: 10,
          font: '700 11px var(--mono)',
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        ▾ got it
      </button>
    </div>
  );
}
