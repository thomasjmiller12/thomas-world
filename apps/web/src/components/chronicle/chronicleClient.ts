import {
  ChronicleResponse,
  ArtifactsResponse,
  ArtifactResponse,
  MessagesResponse,
  type ChronicleItem,
  type ArtifactSummary,
  type Artifact,
  type AgentId,
  type ArtifactKind,
  type Message,
  type MessageScope,
} from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';

// Typed fetchers for the Town Chronicle hub (M2.1 — replaces the feed client).
// Same conventions as the old feedClient: base URL from the build-time env var,
// AbortSignal threading, and a contract-schema parse on every response so drift
// throws loudly. Reads are free and stay live even when the budget is exhausted
// (only chat is gated), so the Chronicle keeps loading in dream mode.

const baseUrl = (): string => resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);

export interface ChroniclePage {
  // The day actually rendered (YYYY-MM-DD) — may differ from the requested day
  // when none was given (server returns the latest).
  day: string;
  // Available days, desc — powers the day picker.
  days: string[];
  items: ChronicleItem[];
}

// GET /chronicle?day=YYYY-MM-DD — a single day's grouped digest. Omitting `day`
// asks the server for the latest day it has.
export async function fetchChronicle(opts: {
  day?: string | null;
  signal?: AbortSignal;
}): Promise<ChroniclePage> {
  const url = new URL(`${baseUrl()}/chronicle`);
  if (opts.day) url.searchParams.set('day', opts.day);
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`chronicle failed: ${res.status}`);
  const parsed = ChronicleResponse.parse(await res.json());
  return { day: parsed.day, days: parsed.days, items: parsed.items };
}

// GET /artifacts?kind=&agent= — the Made/Board browsers' list source.
export async function fetchArtifacts(opts: {
  kind?: ArtifactKind | null;
  agent?: AgentId | null;
  signal?: AbortSignal;
}): Promise<ArtifactSummary[]> {
  const url = new URL(`${baseUrl()}/artifacts`);
  if (opts.kind) url.searchParams.set('kind', opts.kind);
  if (opts.agent) url.searchParams.set('agent', opts.agent);
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`artifacts failed: ${res.status}`);
  const parsed = ArtifactsResponse.parse(await res.json());
  return parsed.artifacts;
}

// GET /artifacts/:id — the full document for the in-hub reader (lazy on open).
export async function fetchArtifact(id: string, signal?: AbortSignal): Promise<Artifact> {
  const url = new URL(`${baseUrl()}/artifacts/${encodeURIComponent(id)}`);
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`artifact failed: ${res.status}`);
  const parsed = ArtifactResponse.parse(await res.json());
  return parsed.artifact;
}

// GET /messages?scope=&cursor= — the agents' DM/broadcast mail, newest first.
// Bodies are public by design (M2 veto-point default: DMs are visible).
export async function fetchMessages(opts: {
  scope?: MessageScope | null;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<{ messages: Message[]; nextCursor: string | null }> {
  const url = new URL(`${baseUrl()}/messages`);
  if (opts.scope) url.searchParams.set('scope', opts.scope);
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  const parsed = MessagesResponse.parse(await res.json());
  return { messages: parsed.messages, nextCursor: parsed.nextCursor };
}
