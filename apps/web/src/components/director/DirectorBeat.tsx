import { useEffect, useState, useCallback } from 'react';
import type { AgentId, LocationId } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import { THOMAS_COLORS } from '@/lib/constants';

// ─── Director / Effect protocol — the visitor-facing "screen" surface ────────
//
// Agents reach across the glass by running a `play_beat` tool server-side; the
// world emits a contract `world.beat`, WorldClient maps it to the EventBus
// `director-beat`, and this overlay renders it. Object-surface beats (a phone
// ringing, a lamp flickering) ride the existing world.effect → fixture-effect
// sprite path and never reach here — this layer is only the screen surface
// (cards popped on the visitor's screen, an emote over a head).
//
// Purely additive: a beat-id component catalog (POPUP_CARD / EMOTE), so a new
// screen beat = a new entry, and unknown beat ids are ignored (forward-compat
// with beats the backend may ship before the frontend learns to draw them).

const AUTO_DISMISS_MS = 8_000;
// The emote drifts up and fades over its own lifetime — shorter than a card.
const EMOTE_LIFE_MS = 3_000;

interface DirectorBeatPayload {
  beat: string;
  params: Record<string, unknown>;
  agent: AgentId | null;
  location: LocationId;
  visitorId: string | null;
  ts?: string;
}

// One active beat in the on-screen queue. `key` is a per-instance id so React
// keys are stable and dismissal targets exactly one entry.
interface ActiveBeat {
  key: string;
  payload: DirectorBeatPayload;
}

// Beat ids this overlay can draw. Anything else is dropped (logged-free) so the
// backend can roll out a beat ahead of the renderer without a console of noise.
const RENDERABLE = new Set(['popup-card', 'emote']);

interface DirectorBeatProps {
  // The current visitor's id, threaded from App.tsx. A directed beat
  // (payload.visitorId set) renders only when it matches; a room-wide beat
  // (null) always renders. We also fall back to the localStorage identity in
  // case the prop hasn't hydrated yet (identity is established asynchronously
  // after mount).
  visitorId: string | null;
}

export function DirectorBeat({ visitorId }: DirectorBeatProps) {
  const [beats, setBeats] = useState<ActiveBeat[]>([]);

  const dismiss = useCallback((key: string) => {
    setBeats(prev => prev.filter(b => b.key !== key));
  }, []);

  useEffect(() => {
    const onBeat = (payload: DirectorBeatPayload) => {
      // Forward-compat: ignore beat ids we don't have a renderer for.
      if (!RENDERABLE.has(payload.beat)) return;

      // Directed-beat filter: a beat aimed at a specific visitor must not leak
      // onto another visitor's screen. null = room-wide (everyone sees it).
      const target = payload.visitorId;
      if (target != null) {
        const me = visitorId ?? readStoredVisitorId();
        if (me == null || me !== target) return;
      }

      const key = `${payload.beat}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setBeats(prev => [...prev, { key, payload }]);

      const life = payload.beat === 'emote' ? EMOTE_LIFE_MS : AUTO_DISMISS_MS;
      setTimeout(() => dismiss(key), life);
    };

    EventBus.on('director-beat', onBeat);
    return () => {
      EventBus.off('director-beat', onBeat);
    };
  }, [visitorId, dismiss]);

  if (beats.length === 0) return null;

  return (
    <>
      {beats.map(({ key, payload }) => {
        if (payload.beat === 'popup-card') {
          return <PopupCard key={key} payload={payload} onClose={() => dismiss(key)} />;
        }
        if (payload.beat === 'emote') {
          return <EmoteBubble key={key} payload={payload} />;
        }
        return null;
      })}
    </>
  );
}

// ─── popup-card ──────────────────────────────────────────────────────────────
// A small framed card popped directly onto the visitor's screen — a gag, a
// quick note, a flourish. params: { title, body, cta?, tone: gag|info|warm }.
function PopupCard({
  payload,
  onClose,
}: {
  payload: DirectorBeatPayload;
  onClose: () => void;
}) {
  const title = asString(payload.params.title) ?? 'A note';
  const body = asString(payload.params.body) ?? '';
  const cta = asString(payload.params.cta);
  const tone = asTone(payload.params.tone);
  const accent = payload.agent ? THOMAS_COLORS[payload.agent] : undefined;

  // Tone treatment: "gag" leans playful (warm tint + a wink), "warm" softens
  // the border to the agent's hue, "info" is the plain ink frame.
  const isGag = tone === 'gag';
  const borderColor = tone === 'warm' && accent ? `${accent}66` : 'var(--line-2)';

  return (
    <div
      className="absolute left-1/2 bottom-24 pointer-events-auto"
      style={{
        zIndex: 1,
        maxWidth: 320,
        width: 'calc(100% - 32px)',
        animation: 'beatCardIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
        transform: 'translateX(-50%)',
      }}
    >
      <div
        className="rounded-xl px-4 py-3 relative"
        style={{
          background: isGag ? 'rgba(255,249,236,0.98)' : 'rgba(252,247,238,0.98)',
          border: `1px solid ${borderColor}`,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Accent bar in the speaking agent's hue, so the card feels "from" them. */}
        {accent && (
          <span
            aria-hidden
            className="absolute left-0 top-3 bottom-3 rounded-full"
            style={{ width: 3, background: accent }}
          />
        )}
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="absolute top-2 right-2 leading-none"
          style={{
            font: '600 14px var(--display)',
            color: 'var(--ink-3)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          ×
        </button>
        <p
          className="text-[12px] mb-1 pr-4"
          style={{ fontFamily: 'var(--display)', fontWeight: 600, color: 'var(--ink)' }}
        >
          {isGag ? `${title} ✨` : title}
        </p>
        {body && (
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
            {body}
          </p>
        )}
        {cta && (
          <button
            onClick={onClose}
            className="mt-2 text-[10px] uppercase px-2.5 py-1 rounded-md"
            style={{
              fontFamily: 'var(--mono)',
              letterSpacing: '0.06em',
              background: accent ?? 'var(--ink)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {cta}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── emote ────────────────────────────────────────────────────────────────────
// A quick visible gesture — a wave, a 🤝, a 🎉 — with optional text. v1 anchors
// it center/over-canvas (NPC-anchoring can come later); it drifts up and fades.
// params: { emoji, text? }.
function EmoteBubble({ payload }: { payload: DirectorBeatPayload }) {
  const emoji = asString(payload.params.emoji) ?? '👋';
  const text = asString(payload.params.text);

  return (
    <div
      className="absolute left-1/2 pointer-events-none flex flex-col items-center"
      style={{
        zIndex: 1,
        top: '38%',
        animation: `beatEmoteFloat ${EMOTE_LIFE_MS}ms ease-out forwards`,
        transform: 'translateX(-50%)',
      }}
    >
      <span style={{ fontSize: 40, lineHeight: 1, filter: 'drop-shadow(0 2px 4px rgba(60,48,30,0.3))' }}>
        {emoji}
      </span>
      {text && (
        <span
          className="mt-1 rounded-full px-2.5 py-0.5 text-[10px]"
          style={{
            fontFamily: 'var(--mono)',
            letterSpacing: '0.04em',
            color: 'var(--ink)',
            background: 'rgba(252,247,238,0.95)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow)',
          }}
        >
          {text}
        </span>
      )}
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────────

// params is a loose record<string, unknown> off the wire; coerce defensively.
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asTone(v: unknown): 'gag' | 'info' | 'warm' {
  return v === 'gag' || v === 'warm' ? v : 'info';
}

// Fallback to the visitor identity WorldClient persists, in case the prop has
// not hydrated when an early directed beat arrives. Mirrors WorldClient's key.
function readStoredVisitorId(): string | null {
  try {
    return localStorage.getItem('town.visitorId');
  } catch {
    return null;
  }
}
