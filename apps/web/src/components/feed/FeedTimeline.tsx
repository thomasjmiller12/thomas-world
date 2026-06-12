import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, AgentId, LocationId } from '@town/contract';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { agentShortName, SpritePortrait } from '@/components/chat/primitives';
import { fetchFeed } from './feedClient';
import {
  labelFor,
  isHiddenFromFeed,
  isSpeech,
  isThought,
  locationLabel,
  clockFor,
  headerDate,
} from './feedPresentation';

// FeedTimeline — the unified-timeline look-back (design doc §6.3, handoff
// feed.jsx). A slide-over panel: header (Fredoka title + Silkscreen date / event
// count), agent filter chips (Everyone + five), and a river of rows — time
// gutter, a 30px agent-tinted spine glyph, and a content card (agent name in
// color, type badge, "→ recipient", italic thoughts vs quoted speech, location).
// Hovering a located row reveals "⌖ SHOW IN TOWN", which resolves to a camera
// move via onShowInTown. Cursor pagination loads more as the river scrolls.

const ALL_AGENTS = Object.values(NPC_CONFIGS);

interface Props {
  onClose: () => void;
  // Show-in-town: resolve a located row to a camera move (design §6.3). Rows in
  // the room you're standing in still offer it (it pans).
  onShowInTown: (locationId: LocationId) => void;
  // Full-screen overlay below the minimum town viewport (panel coexistence rule).
  fullScreen: boolean;
}

export function FeedTimeline({ onClose, onShowInTown, fullScreen }: Props) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState<AgentId | 'all'>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Guards a stale paginated response from a prior filter clobbering a new one.
  const reqSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // (Re)load the first page whenever the filter changes.
  useEffect(() => {
    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    fetchFeed({ agent: active === 'all' ? null : active, signal: ctrl.signal })
      .then((page) => {
        if (seq !== reqSeq.current) return;
        setItems(page.items);
        setCount(page.count);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (seq !== reqSeq.current) return;
        setError(true);
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
    return () => ctrl.abort();
  }, [active]);

  const loadMore = useCallback(() => {
    if (loading || !cursor) return;
    const seq = reqSeq.current;
    setLoading(true);
    fetchFeed({ agent: active === 'all' ? null : active, cursor })
      .then((page) => {
        if (seq !== reqSeq.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
  }, [active, cursor, loading]);

  // Infinite scroll: load the next page near the bottom of the river.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadMore();
  }, [loadMore]);

  const dateLabel = headerDate(items[0]?.ts);

  return (
    <div
      className="pointer-events-auto"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: fullScreen ? '100%' : 420,
        maxWidth: '100%',
        background: 'var(--paper)',
        borderLeft: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-20px 0 50px -30px rgba(0,0,0,.5)',
        animation: 'slideInRight 0.22s ease-out',
        fontFamily: 'var(--sans)',
        zIndex: 41,
      }}
    >
      {/* header */}
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--line)', background: 'var(--paper-2)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 11 }}>
          <div style={{ font: '700 21px var(--display)', color: 'var(--ink)' }}>Today in Thomas&apos;s Town</div>
          <button
            onClick={onClose}
            aria-label="Close feed"
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--ink-3)', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
        <div style={{ font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em', marginTop: 3 }}>
          {dateLabel}
          {dateLabel && ' · '}
          {count} {count === 1 ? 'EVENT' : 'EVENTS'}
        </div>
        {/* agent filter chips */}
        <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
          <Chip on={active === 'all'} onClick={() => setActive('all')} color="var(--ink)" label="Everyone" dot={false} />
          {ALL_AGENTS.map((a) => (
            <Chip
              key={a.id}
              on={active === a.id}
              onClick={() => setActive(a.id)}
              color={THOMAS_COLORS[a.id]}
              label={agentShortName(a.id)}
            />
          ))}
        </div>
      </div>

      {/* river */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
        {error && items.length === 0 && (
          <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
            The town&apos;s day hasn&apos;t loaded yet. It may be dreaming.
          </div>
        )}
        {!error && !loading && items.length === 0 && (
          <div style={{ padding: '24px 4px', color: 'var(--ink-3)', fontSize: 13.5 }}>
            Nothing has happened yet today.
          </div>
        )}
        {items
          .filter((e) => !isHiddenFromFeed(e.type))
          .map((e, i, shown) => (
            <TimelineRow
              key={e.id}
              item={e}
              last={i === shown.length - 1}
              onShowInTown={onShowInTown}
            />
          ))}
        {loading && (
          <div style={{ padding: '12px 4px', font: '400 10.5px var(--mono)', color: 'var(--ink-3)', letterSpacing: '.04em' }}>
            LOADING…
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ on, onClick, color, label, dot = true }: {
  on: boolean; onClick: () => void; color: string; label: string; dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        border: `1px solid ${on ? color : 'var(--line-2)'}`,
        background: on ? color : '#fff',
        color: on ? '#fff' : 'var(--ink-2)',
        font: '600 12.5px var(--sans)',
        cursor: 'pointer',
        transition: 'all .15s',
      }}
    >
      {dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? '#fff' : color }} />}
      {label}
    </button>
  );
}

function TimelineRow({ item, last, onShowInTown }: {
  item: FeedItem; last: boolean; onShowInTown: (l: LocationId) => void;
}) {
  const [hover, setHover] = useState(false);
  const agent = item.agent as ThomasId | null;
  const color = agent ? THOMAS_COLORS[agent] : 'var(--ink-3)';
  const recipient = item.to as ThomasId | null;
  const thought = isThought(item.type);
  const speech = isSpeech(item.type);
  const loc = locationLabel(item.locationId);

  return (
    <div
      style={{ display: 'flex', gap: 13, position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* time gutter */}
      <div style={{ width: 56, textAlign: 'right', font: '400 10px var(--mono)', color: 'var(--ink-3)', paddingTop: 9, flexShrink: 0 }}>
        {clockFor(item.ts)}
      </div>
      {/* spine */}
      <div style={{ position: 'relative', width: 30, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!last && <div style={{ position: 'absolute', top: 18, bottom: -14, width: 2, background: 'var(--line)' }} />}
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: agent ? `${THOMAS_COLORS[agent]}1c` : 'var(--paper-2)',
            border: `1px solid ${agent ? `${THOMAS_COLORS[agent]}40` : 'var(--line)'}`,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            zIndex: 1,
            marginTop: 3,
          }}
        >
          {agent ? (
            // The agent's pixel portrait — bespoke and emoji-free; the type
            // badge next to the name carries the event kind.
            <SpritePortrait npcId={agent} scale={1.4} />
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ink-3)' }} />
          )}
        </div>
      </div>
      {/* content card */}
      <div style={{ flex: 1, paddingBottom: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
          {agent && <span style={{ font: '700 13px var(--sans)', color }}>{agentShortName(agent)} Thomas</span>}
          <span style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', color: 'var(--ink-3)', background: 'var(--paper-2)', padding: '2px 6px', borderRadius: 5 }}>
            {labelFor(item.type)}
          </span>
          {recipient && (
            <span style={{ font: '600 11px var(--sans)', color: 'var(--ink-3)' }}>
              → <span style={{ color: THOMAS_COLORS[recipient], fontWeight: 700 }}>{agentShortName(recipient)}</span>
            </span>
          )}
          {item.locationId && (
            <button
              onClick={() => onShowInTown(item.locationId as LocationId)}
              style={{
                marginLeft: 'auto',
                font: '600 10px var(--mono)',
                color,
                opacity: hover ? 1 : 0,
                letterSpacing: '.04em',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                transition: 'opacity .15s',
                whiteSpace: 'nowrap',
              }}
            >
              ⌖ SHOW IN TOWN
            </button>
          )}
        </div>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: thought ? 'var(--ink-2)' : 'var(--ink)',
            fontStyle: thought ? 'italic' : 'normal',
            wordBreak: 'break-word',
          }}
        >
          {speech ? `“${item.line}”` : item.line}
        </div>
        {loc && (
          <div style={{ font: '400 10px var(--mono)', color: 'var(--ink-3)', marginTop: 5 }}>{loc}</div>
        )}
      </div>
    </div>
  );
}
