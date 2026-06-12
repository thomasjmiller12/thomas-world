import type { WorldEventType, LocationId } from '@town/contract';

// Pure presentation helpers for the FeedTimeline (design doc §6.3, from the
// handoff feed.jsx). Kept free of React/network so the type→glyph mapping, the
// location label, and the date header are unit-testable.

export interface TypeGlyph {
  icon: string;
  label: string;
}

// Map a contract event type to the spine glyph + type badge. Mirrors feed.jsx's
// TYPE table, extended to the full contract event taxonomy. Unknown/aggregate
// rows (type null) fall back to a neutral spark.
const TYPE_GLYPHS: Partial<Record<WorldEventType, TypeGlyph>> = {
  'agent.thought': { icon: '💭', label: 'THOUGHT' },
  'agent.activity': { icon: '🛠️', label: 'WORK' },
  'agent.spoke': { icon: '💬', label: 'SAID' },
  'agent.moved': { icon: '🚶', label: 'MOVED' },
  'conversation.started': { icon: '💬', label: 'TALKING' },
  'conversation.turn': { icon: '💬', label: 'SAID' },
  'conversation.ended': { icon: '💬', label: 'WRAPPED UP' },
  'conversation.converted': { icon: '💬', label: 'JOINED' },
  'message.sent': { icon: '✉️', label: 'MESSAGE' },
  'artifact.created': { icon: '📄', label: 'MADE' },
  'artifact.updated': { icon: '✏️', label: 'REVISED' },
  'bulletin.posted': { icon: '📌', label: 'POSTED' },
  'capability.requested': { icon: '🧰', label: 'ASKED FOR' },
  'visitor.arrived': { icon: '🚪', label: 'ARRIVED' },
  'visitor.left': { icon: '🚪', label: 'LEFT' },
  'visitor.moved': { icon: '🚶', label: 'MOVED' },
  'visitor.interacted': { icon: '✋', label: 'TOUCHED' },
  'world.effect': { icon: '✨', label: 'EFFECT' },
  'chat.started': { icon: '💬', label: 'CHATTED' },
  'chat.ended': { icon: '💬', label: 'CHAT ENDED' },
  'chat.joined': { icon: '💬', label: 'JOINED' },
  'world.time': { icon: '🕰️', label: 'TIME' },
};

const FALLBACK_GLYPH: TypeGlyph = { icon: '·', label: 'EVENT' };

export function glyphFor(type: WorldEventType | null): TypeGlyph {
  return (type && TYPE_GLYPHS[type]) || FALLBACK_GLYPH;
}

// Event types whose `line` is the agent's own words (rendered as quoted speech
// rather than italic narration). Everything else reads as third-person narration
// (thoughts italic, work/moves plain).
const SPEECH_TYPES = new Set<WorldEventType>([
  'agent.spoke',
  'conversation.turn',
]);

export function isSpeech(type: WorldEventType | null): boolean {
  return type != null && SPEECH_TYPES.has(type);
}

export function isThought(type: WorldEventType | null): boolean {
  return type === 'agent.thought';
}

// Human label for a location (matches the roster's BUILDING_LABELS; park &
// town both surface as their proper names).
const LOCATION_LABELS: Record<LocationId, string> = {
  town: 'Town Square',
  park: 'The Park',
  office: 'Office',
  library: 'Library',
  workshop: 'Workshop',
  cafe: 'Cafe',
};

export function locationLabel(locationId: LocationId | null): string {
  return locationId ? LOCATION_LABELS[locationId] : '';
}

// "8:05 AM" style clock from an ISO timestamp, for the time gutter (Silkscreen).
export function clockFor(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// "TUE · JUN 10" header date from the most recent item (or now if empty).
export function headerDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const dow = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return `${dow} · ${mon} ${d.getDate()}`;
}
