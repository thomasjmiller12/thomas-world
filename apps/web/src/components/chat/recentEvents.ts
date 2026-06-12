import {
  AgentProfileResponse,
  type WorldEvent,
  type AgentId,
} from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';
import { agentShortName } from './primitives';

// A typed row for the "BEFORE YOU WALKED IN" rail (design doc §6.3): an emoji
// icon, a Silkscreen label, a human-readable line, and the timestamp. Derived
// from the agent's last few WorldEvents (GET /agents/:id recentEvents).
export interface RailRow {
  id: string;
  icon: string;
  label: string;
  line: string;
  time: string; // e.g. "9:42"
}

const BASE = resolveWorldBaseUrl(
  typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_WORLD_URL : undefined
);

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Map one WorldEvent to a rail row. Returns null for event types that don't
// read as "what the agent was doing" (e.g. visitor.* / chat.* plumbing).
export function eventToRailRow(ev: WorldEvent): RailRow | null {
  const time = clockTime(ev.ts);
  switch (ev.type) {
    case 'agent.thought':
      return { id: ev.id, icon: '💭', label: 'THOUGHT', line: ev.payload.text, time };
    case 'agent.activity':
      return { id: ev.id, icon: '🛠️', label: 'WORK', line: ev.payload.activity, time };
    case 'agent.spoke':
      return { id: ev.id, icon: '💬', label: 'SAID', line: ev.payload.text, time };
    case 'agent.moved':
      return {
        id: ev.id,
        icon: '🚶',
        label: 'MOVED',
        line: `Walked to the ${ev.payload.to}`,
        time,
      };
    case 'message.sent':
      return {
        id: ev.id,
        icon: '✉️',
        label: 'SENT',
        line: ev.payload.broadcast
          ? 'Posted to the group'
          : `DM'd ${ev.payload.to ? agentShortName(ev.payload.to) : 'someone'}`,
        time,
      };
    case 'artifact.created':
    case 'artifact.updated':
      return { id: ev.id, icon: '📝', label: 'MADE', line: ev.payload.title, time };
    case 'bulletin.posted':
      return { id: ev.id, icon: '📌', label: 'POSTED', line: ev.payload.title, time };
    case 'capability.requested':
      return { id: ev.id, icon: '⚡', label: 'ASKED', line: ev.payload.summary, time };
    default:
      return null;
  }
}

// Fetch the agent's recent events and render the top 3 rail rows (most recent
// first). Best-effort: returns [] on any failure (the rail just renders empty,
// the chat still works). Drift throws via the contract schema in dev/test.
export async function fetchRecentRows(agentId: AgentId, limit = 3): Promise<RailRow[]> {
  try {
    const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}`);
    if (!res.ok) return [];
    const profile = AgentProfileResponse.parse(await res.json());
    const rows: RailRow[] = [];
    // recentEvents are oldest→newest by convention; show the newest few.
    for (const ev of [...profile.recentEvents].reverse()) {
      const row = eventToRailRow(ev);
      if (row) rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  } catch {
    return [];
  }
}
