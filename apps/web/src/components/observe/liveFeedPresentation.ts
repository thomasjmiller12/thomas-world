import type { FeedItem } from '@town/contract';

// The observer's live rail is a story surface, not a wire-protocol inspector.
// State-change events are invalidation signals for open interactive artifacts /
// objects; the visible action already has its own event. Visitor presence churn
// is similarly useful to the world runtime but not to someone watching the five
// agents live. Finally, hide the server's legacy fallback instead of exposing a
// raw "(unknown event)" row when the event taxonomy gets ahead of its prose
// renderer.
const NON_STORY_FEED_TYPES = new Set<NonNullable<FeedItem['type']>>([
  'chronicle.updated',
  'agent.rested',
  'visitor.arrived',
  'visitor.left',
  'visitor.moved',
  'artifact.state_changed',
  'object.state_changed',
]);

export function isStoryFeedItem(item: Pick<FeedItem, 'type' | 'line'>): boolean {
  if (item.type && NON_STORY_FEED_TYPES.has(item.type)) return false;
  return item.line.trim().toLowerCase() !== '(unknown event)';
}
