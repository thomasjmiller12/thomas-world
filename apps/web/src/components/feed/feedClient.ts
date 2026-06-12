import { FeedResponse, type FeedItem, type AgentId } from '@town/contract';
import { resolveWorldBaseUrl } from '@/lib/world/mapping';

// Thin GET /feed client for the FeedTimeline (design doc §6.3). Parses through
// the contract schema (drift throws), and threads cursor pagination + the agent
// filter. Reads are free and stay live even when the budget is exhausted (only
// chat is gated), so the feed keeps loading in dream mode — design §7.

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  count: number;
}

const baseUrl = (): string => resolveWorldBaseUrl(process.env.NEXT_PUBLIC_WORLD_URL);

export async function fetchFeed(opts: {
  agent?: AgentId | null;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<FeedPage> {
  const url = new URL(`${baseUrl()}/feed`);
  if (opts.agent) url.searchParams.set('agent', opts.agent);
  if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
  const res = await fetch(url.toString(), { signal: opts.signal });
  if (!res.ok) throw new Error(`feed failed: ${res.status}`);
  const parsed = FeedResponse.parse(await res.json());
  return { items: parsed.items, nextCursor: parsed.nextCursor, count: parsed.count };
}
