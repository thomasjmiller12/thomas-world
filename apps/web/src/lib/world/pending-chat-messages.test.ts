import { describe, expect, it } from 'vitest';
import { PendingChatMessages } from './pending-chat-messages';

describe('PendingChatMessages', () => {
  it('preserves every rapid send in FIFO order', () => {
    const messages = new PendingChatMessages();

    messages.enqueue({ agentId: 'hobby', text: 'first' });
    messages.enqueue({ agentId: 'hobby', text: 'second' });
    messages.enqueue({ agentId: 'writer', text: 'third' });

    expect(messages.dequeue()).toEqual({ agentId: 'hobby', text: 'first' });
    expect(messages.dequeue()).toEqual({ agentId: 'hobby', text: 'second' });
    expect(messages.dequeue()).toEqual({ agentId: 'writer', text: 'third' });
    expect(messages.dequeue()).toBeUndefined();
  });

  it('clears pending messages when the visitor closes the conversation', () => {
    const messages = new PendingChatMessages();
    messages.enqueue({ agentId: 'builder', text: 'one' });
    messages.enqueue({ agentId: 'builder', text: 'two' });

    messages.clear();

    expect(messages.dequeue()).toBeUndefined();
  });
});
