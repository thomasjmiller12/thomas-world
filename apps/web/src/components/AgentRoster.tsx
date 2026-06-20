import { useRef, useState } from 'react';
import type { LocationId } from '@town/contract';
import { NPC_CONFIGS } from '@/game/data/npc-configs';
import { THOMAS_COLORS } from '@/lib/constants';
import type { ThomasId, NPCConfig } from '@/lib/types';
import { useAgentStatuses, statusLine, type AgentStatusMap } from '@/lib/useAgentStatuses';
import { SpritePortrait, StatusDot, agentShortName } from '@/components/chat/primitives';
import { locationLabel } from '@/components/chronicle/chroniclePresentation';
import { ProfilePopover } from '@/components/ProfilePopover';

// AgentRoster — restyled to the design system and fully live (design doc §6.2 +
// §6.3). Each row shows the agent's color-keyed name, live location, and a
// status line. Engagement rows ("with a visitor — Workshop") are CLICKABLE: the
// row resolves the agent's live location into a camera move (travel) so the
// visitor can go find them. Proximity + selected states read in the agent color.
// Clicking a row's portrait/name opens a lightweight ProfilePopover (M2.1,
// replaces the old RightPanel rail) anchored beside the rail.

const HOME_FALLBACK: Record<string, LocationId> = {
  office: 'office',
  library: 'library',
  workshop: 'workshop',
  cafe: 'cafe',
  park: 'park',
  town: 'town',
};

interface AgentRosterProps {
  proximityNpcId: ThomasId | null;
  chatNpcId: ThomasId | null;
  selectedNpcId: ThomasId | null;
  onNpcClick: (id: ThomasId) => void;
  // Travel/listen-in: go to where this agent is (engagement rows + profile).
  onTravelToAgent: (id: ThomasId, locationId: LocationId) => void;
  // "see their day →" (profile popover): open the Chronicle scoped to this agent.
  onSeeTheirDay: (id: ThomasId) => void;
  // "proof & projects →" (profile popover): open the About hub for this facet.
  onAboutFacet: (id: ThomasId) => void;
}

export function AgentRoster({
  proximityNpcId,
  chatNpcId,
  selectedNpcId,
  onNpcClick,
  onTravelToAgent,
  onSeeTheirDay,
  onAboutFacet,
}: AgentRosterProps) {
  const [collapsed, setCollapsed] = useState(false);
  // The agent whose ProfilePopover is open + the row's top offset to anchor it.
  const [profile, setProfile] = useState<{ id: ThomasId; top: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const statuses = useAgentStatuses();
  const npcs = Object.values(NPC_CONFIGS);

  // Toggle the popover for a row; anchor it to the row's top (relative to the
  // rail) so it lines up beside the resident that opened it. Also forwards the
  // roster-highlight selection to App.
  const handleRowClick = (id: ThomasId, rowEl: HTMLElement | null) => {
    onNpcClick(id);
    setProfile((cur) => {
      if (cur?.id === id) return null; // toggle off
      // Viewport-space top of the row — the popover is position:fixed so the
      // 208px overflow-hidden rail can't clip it.
      const rowTop = rowEl?.getBoundingClientRect().top ?? 0;
      return { id, top: rowTop };
    });
  };

  if (collapsed) {
    return (
      <div
        className="h-full flex flex-col items-center pt-3 gap-3"
        style={{ width: 44, background: 'var(--paper-2)', borderRight: '1px solid var(--line)' }}
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Show residents"
          style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          &rsaquo;
        </button>
        {npcs.map((config) => (
          <button
            key={config.id}
            onClick={() => { setCollapsed(false); onNpcClick(config.id); }}
            title={config.displayName}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <span
              style={{
                display: 'block',
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: config.color,
                boxShadow:
                  proximityNpcId === config.id || chatNpcId === config.id
                    ? `0 0 0 3px ${config.color}40`
                    : 'none',
              }}
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={railRef}
      className="h-full flex flex-col overflow-hidden"
      style={{ width: 208, background: 'var(--paper-2)', borderRight: '1px solid var(--line)', position: 'relative' }}
    >
      <div
        className="flex items-center justify-between"
        style={{ padding: '13px 16px 11px', borderBottom: '1px solid var(--line)' }}
      >
        <span style={{ font: '700 10px var(--mono)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          Residents
        </span>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse"
          style={{ color: 'var(--ink-3)', fontSize: 13, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          &lsaquo;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {npcs.map((config) => (
          <RosterEntry
            key={config.id}
            config={config}
            status={statuses}
            isNear={proximityNpcId === config.id}
            isChatting={chatNpcId === config.id}
            isSelected={selectedNpcId === config.id || profile?.id === config.id}
            onClick={(rowEl) => handleRowClick(config.id, rowEl)}
            onTravel={onTravelToAgent}
          />
        ))}
      </div>

      {profile && (
        <ProfilePopover
          npcId={profile.id}
          anchorTop={profile.top}
          onClose={() => setProfile(null)}
          onFindThem={(id, locationId) => {
            onTravelToAgent(id, locationId);
            setProfile(null);
          }}
          onSeeTheirDay={(id) => {
            onSeeTheirDay(id);
            setProfile(null);
          }}
          onAboutFacet={(id) => {
            onAboutFacet(id);
            setProfile(null);
          }}
        />
      )}
    </div>
  );
}

function RosterEntry({ config, status, isNear, isChatting, isSelected, onClick, onTravel }: {
  config: NPCConfig;
  status: AgentStatusMap;
  isNear: boolean;
  isChatting: boolean;
  isSelected: boolean;
  onClick: (rowEl: HTMLElement) => void;
  onTravel: (id: ThomasId, locationId: LocationId) => void;
}) {
  const live = status[config.id];
  const color = config.color;
  // Live location when known, else the home building as a placeholder.
  const locationId: LocationId =
    live?.locationId ?? HOME_FALLBACK[config.homeBuilding] ?? 'town';
  const location = locationLabel(locationId);
  // The only engagement now is a visitor chat (paced scenes removed in M2.1).
  const engaged = live?.engagement?.kind === 'chat';
  const highlight = isChatting || isSelected;

  return (
    <button
      onClick={(e) => onClick(e.currentTarget)}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '11px 14px',
        borderBottom: '1px solid var(--line)',
        borderLeft: `3px solid ${highlight || isNear ? color : 'transparent'}`,
        background: highlight ? `${color}12` : 'transparent',
        cursor: 'pointer',
        transition: 'background .15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div
          style={{ width: 26, height: 26, borderRadius: 8, background: `${color}1c`, display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}
        >
          <SpritePortrait npcId={config.id} scale={1.2} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ font: '700 12.5px var(--sans)', color }}>{agentShortName(config.id)}</span>
            {isNear && <StatusDot color={color} size={6} />}
          </div>
          <div style={{ font: '400 9px var(--mono)', letterSpacing: '.04em', color: 'var(--ink-3)', marginTop: 2 }}>
            {location}
          </div>
        </div>
      </div>
      {engaged ? (
        // CLICKABLE engagement chip: travel to where the agent is (go say hi).
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onTravel(config.id, locationId); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onTravel(config.id, locationId); }
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            marginTop: 7,
            padding: '3px 8px',
            borderRadius: 999,
            background: `${color}12`,
            border: `1px solid ${color}2e`,
            font: '700 8px var(--mono)',
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            color,
            cursor: 'pointer',
            lineHeight: 1.4,
          }}
        >
          <StatusDot color={color} size={5} />
          with a visitor · {location} ›
        </span>
      ) : (
        <p
          style={{
            marginTop: 6,
            paddingLeft: 1,
            fontSize: 10.5,
            color: 'var(--ink-2)',
            lineHeight: 1.4,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {statusLine(live)}
        </p>
      )}
    </button>
  );
}
