import { useEffect, useRef } from 'react';
import type { LocationId } from '@town/contract';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId } from '@/lib/types';
import { useAgentStatuses, statusLine } from '@/lib/useAgentStatuses';
import { SpritePortrait, StatusDot, agentShortName } from '@/components/chat/primitives';
import { locationLabel } from '@/components/chronicle/chroniclePresentation';

// ProfilePopover — the lightweight resident profile (M2.1, replaces RightPanel).
// Anchored to a roster row: pixel portrait, the static bio from NPC config, a
// live status line, and two actions — "find them →" (travel to where they are)
// and "see their day →" (open the Chronicle filtered/scrolled to this agent).
// Click-outside / Escape dismiss it. Positioned `absolute` to the LEFT of the
// roster's right edge so it floats over the canvas, not the rail.

const HOME_FALLBACK: Record<string, LocationId> = {
  office: 'office',
  library: 'library',
  workshop: 'workshop',
  cafe: 'cafe',
  park: 'park',
  town: 'town',
};

interface Props {
  npcId: ThomasId;
  // Anchor: the roster row's viewport-space top (px). The card is position:fixed
  // (so the overflow-hidden rail can't clip it) and lines up beside the row.
  anchorTop: number;
  onClose: () => void;
  onFindThem: (id: ThomasId, locationId: LocationId) => void;
  onSeeTheirDay: (id: ThomasId) => void;
  onAboutFacet: (id: ThomasId) => void;
}

export function ProfilePopover({ npcId, anchorTop, onClose, onFindThem, onSeeTheirDay, onAboutFacet }: Props) {
  const config = NPC_CONFIGS[npcId];
  const color = THOMAS_COLORS[npcId] ?? 'var(--career)';
  const statuses = useAgentStatuses();
  const live = statuses[npcId];
  const ref = useRef<HTMLDivElement>(null);

  const locationId: LocationId = live?.locationId ?? HOME_FALLBACK[config?.homeBuilding ?? 'town'] ?? 'town';

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer the click listener a tick so the opening click doesn't immediately close.
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="pointer-events-auto"
      style={{
        position: 'fixed',
        left: 208 + 10, // just right of the 208px roster rail
        top: Math.max(8, anchorTop),
        width: 268,
        zIndex: 50,
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        fontFamily: 'var(--sans)',
        animation: 'slideInRight .18s ease-out',
      }}
    >
      {/* header */}
      <div style={{ padding: '14px 16px', background: `${color}10`, borderBottom: `1px solid ${color}26`, display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: `${color}1c`, border: `1px solid ${color}40`, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
          <SpritePortrait npcId={npcId} scale={1.7} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: '700 15px var(--display)', color }}>{config?.displayName}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <StatusDot color={color} size={6} />
            <span style={{ font: '400 9.5px var(--mono)', letterSpacing: '.04em', color: 'var(--ink-3)', textTransform: 'uppercase' }}>
              {locationLabel(locationId)}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close profile"
          style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--ink-3)', fontSize: 17, lineHeight: 1, cursor: 'pointer', alignSelf: 'flex-start' }}
        >
          ×
        </button>
      </div>

      {/* body */}
      <div style={{ padding: '13px 16px 14px' }}>
        <p style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 4px' }}>
          Right now
        </p>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.45, margin: '0 0 12px' }}>
          {statusLine(live)}
        </p>
        <p style={{ font: '700 9px var(--mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 4px' }}>
          About
        </p>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, margin: 0 }}>
          {config?.aboutText}
        </p>
      </div>

      {/* actions */}
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px' }}>
        <button
          onClick={() => onFindThem(npcId, locationId)}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 10,
            border: `1px solid ${color}`,
            background: color,
            color: '#fff',
            font: '700 12px var(--sans)',
            cursor: 'pointer',
          }}
        >
          find them →
        </button>
        <button
          onClick={() => onSeeTheirDay(npcId)}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 10,
            border: '1px solid var(--line-2)',
            background: '#fff',
            color: 'var(--ink-2)',
            font: '700 12px var(--sans)',
            cursor: 'pointer',
          }}
        >
          see their day →
        </button>
      </div>

      {/* proof & projects — opens the About hub on this facet (M2.2) */}
      <div style={{ padding: '0 16px 16px' }}>
        <button
          onClick={() => onAboutFacet(npcId)}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 10,
            border: `1px solid ${color}40`,
            background: `${color}10`,
            color,
            font: '700 12px var(--sans)',
            cursor: 'pointer',
          }}
        >
          proof &amp; projects →
        </button>
      </div>
    </div>
  );
}
