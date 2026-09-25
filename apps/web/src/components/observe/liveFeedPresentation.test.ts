import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@town/contract';
import { isStoryFeedItem } from './liveFeedPresentation';

function feedItem(type: FeedItem['type'], line: string): Pick<FeedItem, 'type' | 'line'> {
  return { type, line };
}

describe('isStoryFeedItem', () => {
  it('keeps agent actions that form the observer story', () => {
    expect(
      isStoryFeedItem(feedItem('agent.spoke', 'Builder Thomas said: "I made a thing."')),
    ).toBe(true);
  });

  it('hides artifact and object state invalidation noise', () => {
    expect(isStoryFeedItem(feedItem('artifact.state_changed', 'State changed.'))).toBe(false);
    expect(isStoryFeedItem(feedItem('object.state_changed', 'State changed.'))).toBe(false);
  });

  it('hides visitor presence churn', () => {
    expect(isStoryFeedItem(feedItem('visitor.arrived', 'Someone arrived in town.'))).toBe(false);
    expect(isStoryFeedItem(feedItem('visitor.left', 'Someone left town.'))).toBe(false);
    expect(isStoryFeedItem(feedItem('visitor.moved', 'Someone wandered into the park.'))).toBe(false);
  });

  it('never exposes the server fallback as a timeline row', () => {
    expect(isStoryFeedItem(feedItem('world.beat', '(unknown event)'))).toBe(false);
    expect(isStoryFeedItem(feedItem(null, ' (UNKNOWN EVENT) '))).toBe(false);
  });
});
