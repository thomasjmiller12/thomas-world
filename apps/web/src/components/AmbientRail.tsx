import { useEffect, useRef, useState } from 'react';
import type { WorldEvent, LocationId } from '@town/contract';
import { EventBus } from '@/game/EventBus';
import type { ThomasId } from '@/lib/types';
import { agentColor, agentShortName } from './chat/primitives';
import { locationLabel } from './chronicle/chroniclePresentation';

// AmbientRail — a slim "around town" feed docked bottom-left while a chat is
// open. It answers the question the 1:1 chat panel couldn't: *what else is
// going on?* Agents message each other ("Hobby → Writer: come join"), walk
// between rooms, and make things while you talk — those land here live so a
// summons or an arrival pops up instead of being discoverable only later in the
// Chronicle. Fed by the raw world-event stream; the room conversation itself
// stays in the chat panel.

interface RailItem {
  id: string;
  icon: string;
  text: string;
  color: string;
  ts: string;
}

const MAX_ROWS = 8;

function shortName(id: string): string {
  return agentShortName(id as ThomasId);
}

function hue(id: string): string {
  return agentColor(id as ThomasId);
}

function room(loc: LocationId | null | undefined): string {
  return loc ? locationLabel(loc) : 'town';
}

// Map a world event to a rail row, or null if it isn't "ambient life". Room
// speech (agent.spoke) is deliberately excluded — it belongs in the transcript,
// not the side feed — as are thoughts and visitor-presence plumbing.
function toItem(ev: WorldEvent): RailItem | null {
  switch (ev.type) {
    case 'message.sent':
      return {
        id: ev.id,
        icon: '✉️',
        color: hue(ev.payload.from),
        ts: ev.ts,
        text: ev.payload.broadcast
          ? `${shortName(ev.payload.from)} posted to the group`
          : `${shortName(ev.payload.from)} → ${ev.payload.to ? shortName(ev.payload.to) : 'someone'}`,
      };
    case 'agent.moved':
      return {
        id: ev.id,
        icon: '🚶',
        color: hue(ev.payload.agent),
        ts: ev.ts,
        text: `${shortName(ev.payload.agent)} headed to the ${room(ev.payload.to)}`,
      };
    case 'artifact.created':
    case 'artifact.updated':
      return {
        id: ev.id,
        icon: '✦',
        color: hue(ev.payload.agent),
        ts: ev.ts,
        text: `${shortName(ev.payload.agent)} ${ev.type === 'artifact.created' ? 'made' : 'updated'} “${ev.payload.title}”`,
      };
    case 'bulletin.posted':
      return {
        id: ev.id,
        icon: '📌',
        color: hue(ev.payload.agent),
        ts: ev.ts,
        text: `${shortName(ev.payload.agent)} pinned “${ev.payload.title}”`,
      };
    case 'capability.requested':
      return {
        id: ev.id,
        icon: '⚡',
        color: hue(ev.payload.agent),
        ts: ev.ts,
        text: `${shortName(ev.payload.agent)} asked: ${ev.payload.summary}`,
      };
    default:
      return null;
  }
}

export function AmbientRail() {
  const [items, setItems] = useState<RailItem[]>([]);
  // De-dupe by event id (a reconnect replay can re-deliver an event).
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onEvent = (ev: WorldEvent) => {
      const item = toItem(ev);
      if (!item || seen.current.has(item.id)) return;
      seen.current.add(item.id);
      setItems((prev) => [item, ...prev].slice(0, MAX_ROWS));
    };
    EventBus.on('world-event', onEvent);
    return () => {
      EventBus.off('world-event', onEvent);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none"
      style={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        width: 'min(280px, 40vw)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 35,
      }}
    >
      <div
        style={{
          font: '700 8.5px var(--mono)',
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          paddingLeft: 4,
          marginBottom: 2,
        }}
      >
        Around town
      </div>
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            borderRadius: 10,
            background: 'var(--paper-2)',
            border: '1px solid var(--line)',
            borderLeft: `3px solid ${it.color}`,
            boxShadow: 'var(--shadow)',
            animation: 'slideInRight 0.2s ease-out',
          }}
        >
          <span style={{ fontSize: 12, flexShrink: 0 }}>{it.icon}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: 'var(--ink-2)',
              lineHeight: 1.35,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {it.text}
          </span>
        </div>
      ))}
    </div>
  );
}
