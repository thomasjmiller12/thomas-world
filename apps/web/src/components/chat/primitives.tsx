import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThomasId } from '@/lib/types';
import { THOMAS_COLORS } from '@/lib/constants';
import { NPC_CONFIGS } from '@/game/data/npc-configs';

// Shared chat-surface primitives, ported from the design handoff
// (design/town-concepts-handoff/project/screens/chat.jsx + shared.jsx) to the
// design tokens. Used by both the diegetic (Tier 1) and docked (Tier 2)
// presentations of the one ChatSession container.

export function agentColor(id: ThomasId): string {
  return THOMAS_COLORS[id] || 'var(--career)';
}

// "Career Thomas" → display name (full), and the short "Career" form for
// nameplates where the surname is redundant.
export function agentFullName(id: ThomasId): string {
  return NPC_CONFIGS[id]?.displayName ?? id;
}
export function agentShortName(id: ThomasId): string {
  return agentFullName(id).replace('Thomas', '').trim() || id;
}

// A soft pulsing presence dot (handoff StatusDot). The pulse color is driven by
// CSS vars so the keyframe (globals.css @keyframes pulse) can animate the ring.
export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        // initial ring + the animated ring colors (color + opacity idiom)
        boxShadow: `0 0 0 3px ${color}33`,
        ['--pulse-color' as string]: `${color}33`,
        ['--pulse-color-faint' as string]: `${color}14`,
        animation: 'pulse 2.4s infinite',
      }}
    />
  );
}

// A conversation bubble. Agent bubbles are white with a color-tinted border;
// the visitor bubble is ink-filled (handoff Bubble). `memory` renders the
// restrained "RECALLED FROM EARLIER TODAY" chip inside the bubble.
export function Bubble({
  side,
  color,
  name,
  children,
  memory,
}: {
  side: 'visitor' | 'agent';
  color?: string;
  name?: string;
  children: ReactNode;
  memory?: string | null;
}) {
  const mine = side === 'visitor';
  const c = color ?? 'var(--career)';
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
      <div style={{ maxWidth: '82%' }}>
        {!mine && name && (
          <div
            style={{
              font: `700 11px var(--mono)`,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: c,
              marginBottom: 5,
              paddingLeft: 2,
            }}
          >
            {name}
          </div>
        )}
        <div
          style={{
            padding: '11px 14px',
            borderRadius: mine ? '16px 16px 5px 16px' : '16px 16px 16px 5px',
            background: mine ? 'var(--ink)' : '#fff',
            color: mine ? '#fff' : 'var(--ink)',
            border: mine ? 'none' : `1px solid ${c}2e`,
            fontSize: 14.5,
            lineHeight: 1.5,
            boxShadow: mine ? 'none' : `0 1px 0 ${c}14, 0 8px 20px -14px rgba(60,48,30,.4)`,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {memory && <MemoryChip color={c} label={memory} />}
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}

// "↩ RECALLED FROM EARLIER TODAY" — emitted when a memory_recalled frame lands
// mid-turn. Restraint by design (never a counter): the label comes from the
// frame's recency string (design doc §5).
export function MemoryChip({ color, label }: { color: string; label: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        font: `700 10px var(--mono)`,
        letterSpacing: '.03em',
        textTransform: 'uppercase',
        color,
        background: `${color}14`,
        padding: '3px 8px',
        borderRadius: 999,
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 11 }}>↩</span> {label}
    </div>
  );
}

// Three bouncing dots while a turn streams (handoff StreamDots).
export function StreamDots({ color }: { color: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 5,
        padding: '13px 16px',
        background: '#fff',
        width: 'fit-content',
        border: `1px solid ${color}2e`,
        borderRadius: '16px 16px 16px 5px',
        marginBottom: 12,
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: color,
            opacity: 0.5,
            animation: `stream 1.1s ${i * 0.16}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

// A pixel-art portrait of an agent's sprite sheet (frame 0 = front idle). The
// roster + index already render sprites this way; centralized here for the chat
// surfaces (diegetic portrait panel + docked header avatar).
export function SpritePortrait({ npcId, scale = 1.5 }: { npcId: ThomasId; scale?: number }) {
  const sprite = NPC_CONFIGS[npcId]?.sprite ?? 'thomas-career';
  return (
    <div
      style={{
        width: 16,
        height: 24,
        backgroundImage: `url(/assets/sprites/${sprite}.png)`,
        backgroundPosition: '0 0',
        backgroundSize: '64px 96px',
        imageRendering: 'pixelated',
        transform: `scale(${scale})`,
        transformOrigin: 'center',
      }}
    />
  );
}

// Typewriter reveal for the diegetic greeting. `on` gates the effect (false =>
// reveal instantly, e.g. for already-complete text). When `text` grows mid-
// stream (deltas append), the reveal continues from where it was rather than
// restarting — so a streaming greeting types out smoothly.
export function useTypewriter(text: string, speed = 22, on = true): { shown: string; done: boolean } {
  const [n, setN] = useState(on ? 0 : text.length);
  const nRef = useRef(n);
  nRef.current = n;

  useEffect(() => {
    if (!on) {
      setN(text.length);
      return;
    }
    // Don't restart from 0 when text grows; only clamp if it shrank (new turn).
    if (nRef.current > text.length) setN(text.length);
    const t = setInterval(() => {
      setN((cur) => {
        if (cur >= text.length) return cur;
        return cur + 1;
      });
    }, speed);
    return () => clearInterval(t);
  }, [text, on, speed]);

  return { shown: text.slice(0, n), done: n >= text.length };
}
