import type { WorldEventType, LocationId } from '@town/contract';

// Pure presentation helpers for the FeedTimeline (design doc §6.3, from the
// handoff feed.jsx). Kept free of React/network so the type→glyph mapping, the
// location label, and the date header are unit-testable.

// Map a contract event type to its Silkscreen type badge. No emoji glyphs —
// the spine tile carries the agent's pixel portrait (or a neutral dot for
// world/visitor rows); the badge alone names the event kind (Thomas's call,
// 2026-06-12: the emoji tiles read as noise).
const TYPE_LABELS: Partial<Record<WorldEventType, string>> = {
  'agent.thought': 'THOUGHT',
  'agent.activity': 'WORK',
  'agent.spoke': 'SAID',
  'agent.moved': 'MOVED',
  'conversation.started': 'TALKING',
  'conversation.turn': 'SAID',
  'conversation.ended': 'WRAPPED UP',
  'conversation.converted': 'JOINED',
  'message.sent': 'MESSAGE',
  'artifact.created': 'MADE',
  'artifact.updated': 'REVISED',
  'bulletin.posted': 'POSTED',
  'capability.requested': 'ASKED FOR',
  'visitor.arrived': 'ARRIVED',
  'visitor.left': 'LEFT',
  'visitor.moved': 'MOVED',
  'visitor.interacted': 'TOUCHED',
  'world.effect': 'EFFECT',
  'chat.started': 'CHATTED',
  'chat.ended': 'CHAT ENDED',
  'chat.joined': 'JOINED',
  'world.time': 'TIME',
};

export function labelFor(type: WorldEventType | null): string {
  return (type && TYPE_LABELS[type]) || 'EVENT';
}

// Visitor presence chatter (arrive/leave/room-to-room moves) drowns out the
// agents' day — the feed is "what the agents did today", so presence rows are
// hidden from the timeline. visitor.interacted stays (picking up the ringing
// phone is story, not noise).
const HIDDEN_TYPES = new Set<WorldEventType>([
  'visitor.arrived',
  'visitor.left',
  'visitor.moved',
]);

export function isHiddenFromFeed(type: WorldEventType | null): boolean {
  return type != null && HIDDEN_TYPES.has(type);
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
