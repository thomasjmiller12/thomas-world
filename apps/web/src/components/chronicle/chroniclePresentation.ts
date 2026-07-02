import type { LocationId } from '@town/contract';
import type { ThomasId } from '@/lib/types';
import { agentShortName } from '@/components/chat/primitives';

// Pure presentation helpers for the Town Chronicle hub (M2.1 — replaces the feed
// side panel). Kept free of React/network so the labels, clocks, day formatting,
// and thread-headline composition stay unit-testable. ABSORBS the locationLabel,
// clockFor, and headerDate helpers that used to live in the deleted
// feedPresentation.ts (AgentRoster now imports them from here).

// Human label for a location (matches the roster's BUILDING_LABELS; park & town
// both surface as their proper names).
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

// "TUE · JUN 10" header date from an ISO timestamp (or now if undefined).
export function headerDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const dow = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return `${dow} · ${mon} ${d.getDate()}`;
}

// "TUE · JUN 10" day chip from a YYYY-MM-DD day key (the Chronicle's day picker
// works in calendar days, not ISO instants). Parsed as a local date — the day
// key already carries no time, so we avoid the UTC-midnight off-by-one by
// constructing from the y/m/d parts directly.
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return '';
  const dow = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return `${dow} · ${mon} ${d.getDate()}`;
}

// "Today" / "Yesterday" / full day label, picking the friendly word when the
// day key matches the local today/yesterday. `now` defaults to the wall clock
// (passable for testing).
export function relativeDayLabel(day: string, now: Date = new Date()): string {
  const todayKey = toDayKey(now);
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (day === todayKey) return 'Today';
  if (day === toDayKey(yest)) return 'Yesterday';
  return dayLabel(day);
}

// Local YYYY-MM-DD key for a Date (matches the server's day partitioning).
export function toDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Headline for a room-talk thread: "Builder & Researcher talked at the Library".
// Short names (no surname) joined naturally; falls back to "Someone" for an
// empty participant list (shouldn't happen, but keeps the line legible).
export function threadHeadline(participants: ThomasId[], locationId: LocationId): string {
  const names = participants.map((p) => agentShortName(p));
  const where = locationLabel(locationId);
  const who = joinNames(names);
  const verb = participants.length > 2 ? 'talked' : 'talked';
  return where ? `${who} ${verb} at the ${where}` : `${who} ${verb}`;
}

// "A", "A & B", "A, B & C" — Oxford-less natural join of short names.
export function joinNames(names: string[]): string {
  if (names.length === 0) return 'Someone';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

// "3 turns" / "1 turn" pluralization for the thread meta.
export function turnCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'turn' : 'turns'}`;
}

// Human label for an artifact kind badge (Silkscreen, uppercased at render).
const ARTIFACT_KIND_LABELS: Record<string, string> = {
  blog_post: 'Blog Post',
  project_log: 'Project Log',
  research_note: 'Research Note',
  bulletin: 'Bulletin',
  fun_list: 'List',
  diary_entry: 'Diary',
  daily_digest: 'Digest',
  interactive: 'App',
  shared_page: 'Shared Page',
};

export function artifactKindLabel(kind: string): string {
  return ARTIFACT_KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}
