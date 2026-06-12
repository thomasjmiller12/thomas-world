import { useState } from 'react';
import type { LocationId, AgentId } from '@town/contract';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { SpritePortrait, agentShortName } from '@/components/chat/primitives';
import { clockFor, threadHeadline, turnCountLabel } from './chroniclePresentation';

// A room-talk thread inside the Chronicle (emergent agent↔agent talk). M2.1:
// progressive disclosure — collapsed shows stacked participant portraits, the
// headline (short names in their agent hues), a summary line (falls back to the
// first turn when the server summary is null), turn count + clock, and a
// chevron. Expands IN PLACE (local state, animated) to the full attributed
// transcript. No network on expand — the turns ride inline on the ChronicleItem.

interface ThreadItem {
  id: string;
  ts: string;
  locationId: LocationId;
  participants: AgentId[];
  summary: string | null;
  turns: { agent: AgentId; to?: AgentId; text: string; ts: string }[];
}

export function ThreadRow({ thread, last }: { thread: ThreadItem; last: boolean }) {
  const [open, setOpen] = useState(false);
  const participants = thread.participants as ThomasId[];
  // Lead participant's hue tints the spine; the headline colors each name.
  const leadColor = participants[0] ? THOMAS_COLORS[participants[0]] : 'var(--ink-3)';
  // Summary line: prefer the server summary, fall back to the first turn's text.
  const summaryLine = thread.summary ?? thread.turns[0]?.text ?? '';

  return (
    <div style={{ display: 'flex', gap: 13, position: 'relative' }}>
      {/* time gutter */}
      <div style={{ width: 56, textAlign: 'right', font: '400 10px var(--mono)', color: 'var(--ink-3)', paddingTop: 9, flexShrink: 0 }}>
        {clockFor(thread.ts)}
      </div>
      {/* spine: stacked participant portraits */}
      <div style={{ position: 'relative', width: 30, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!last && <div style={{ position: 'absolute', top: 18, bottom: -14, width: 2, background: 'var(--line)' }} />}
        <StackedPortraits participants={participants} leadColor={leadColor} />
      </div>
      {/* content */}
      <div style={{ flex: 1, paddingBottom: 16, minWidth: 0 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'block',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ font: '700 13px var(--sans)', color: 'var(--ink)', flex: 1, minWidth: 0 }}>
              <Headline participants={participants} locationId={thread.locationId} />
            </span>
            <span style={{ font: '400 9.5px var(--mono)', letterSpacing: '.04em', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
              {turnCountLabel(thread.turns.length)}
            </span>
            <span
              style={{
                color: 'var(--ink-3)',
                fontSize: 13,
                transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform .18s ease',
                display: 'inline-block',
              }}
            >
              ›
            </span>
          </div>
          {!open && summaryLine && (
            <div
              style={{
                fontSize: 13.5,
                lineHeight: 1.5,
                color: 'var(--ink-2)',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {summaryLine}
            </div>
          )}
        </button>

        {/* expanded transcript (animated in place) */}
        {open && (
          <div
            style={{
              marginTop: 10,
              paddingLeft: 12,
              borderLeft: `2px solid ${leadColor}2e`,
              animation: 'fadeInUp .18s ease-out',
            }}
          >
            {thread.turns.map((turn, i) => {
              const tColor = THOMAS_COLORS[turn.agent as ThomasId] ?? 'var(--ink-3)';
              return (
                <div key={`${thread.id}-${i}`} style={{ display: 'flex', gap: 9, marginBottom: 10 }}>
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 7,
                      background: `${tColor}1c`,
                      border: `1px solid ${tColor}40`,
                      display: 'grid',
                      placeItems: 'center',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    <SpritePortrait npcId={turn.agent as ThomasId} scale={1.0} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ font: '700 11px var(--sans)', color: tColor }}>
                      {agentShortName(turn.agent)}
                    </span>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink)', wordBreak: 'break-word' }}>
                      {turn.text}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// The headline with each short name in its agent hue: "Builder & Researcher
// talked at the Library". Built off the same string the pure helper composes,
// then re-colored by splicing the names back in (the helper stays testable).
function Headline({ participants, locationId }: { participants: ThomasId[]; locationId: LocationId }) {
  const full = threadHeadline(participants, locationId);
  // Color each short name where it appears. We render the headline as a sequence
  // of colored name spans + the surrounding plain text from the helper.
  const names = participants.map((p) => ({ name: agentShortName(p), color: THOMAS_COLORS[p] }));
  const nodes: React.ReactNode[] = [];
  let rest = full;
  let key = 0;
  // Walk the names in order; everything before each name is plain text.
  for (const { name, color } of names) {
    const idx = rest.indexOf(name);
    if (idx === -1) continue;
    if (idx > 0) nodes.push(<span key={key++}>{rest.slice(0, idx)}</span>);
    nodes.push(
      <span key={key++} style={{ color, fontWeight: 700 }}>
        {name}
      </span>,
    );
    rest = rest.slice(idx + name.length);
  }
  if (rest) nodes.push(<span key={key++}>{rest}</span>);
  return <>{nodes}</>;
}

function StackedPortraits({ participants, leadColor }: { participants: ThomasId[]; leadColor: string }) {
  // Up to two portraits overlap in the 30px spine slot; a "+N" pill covers the
  // rest (rare — threads are usually a pair).
  const shown = participants.slice(0, 2);
  return (
    <div style={{ position: 'relative', width: 30, height: 30, marginTop: 3, zIndex: 1 }}>
      {shown.map((p, i) => {
        const c = THOMAS_COLORS[p] ?? leadColor;
        return (
          <div
            key={p}
            style={{
              position: 'absolute',
              left: i * 9,
              top: i * 2,
              width: 24,
              height: 24,
              borderRadius: 8,
              background: `${c}1c`,
              border: `1px solid ${c}55`,
              display: 'grid',
              placeItems: 'center',
              overflow: 'hidden',
              boxShadow: '0 1px 2px rgba(60,48,30,.12)',
            }}
          >
            <SpritePortrait npcId={p} scale={1.1} />
          </div>
        );
      })}
      {participants.length > 2 && (
        <span
          style={{
            position: 'absolute',
            left: 20,
            top: 6,
            font: '700 8px var(--mono)',
            color: 'var(--ink-3)',
          }}
        >
          +{participants.length - 2}
        </span>
      )}
    </div>
  );
}
