import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../EventBus', () => ({ EventBus: { emit: vi.fn() } }));
import { EventBus } from '../EventBus';
import { WorldClient } from './WorldClient';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('dropped room response recovery', () => {
  it('replays the final reply and closes the panel when chat_ended was lost', async () => {
    vi.useFakeTimers();
    const client = new WorldClient('Visitor', { envUrl: 'http://localhost:8787' });
    const chat = {
      sessionId: 'room-1', sessionToken: 'secret', participants: ['builder', 'writer'],
      primaryAgent: 'builder', pingTimer: null, abort: null, turnText: new Map(),
      streamSettled: false, seenMessageIds: new Set(),
    };
    type ChatState = typeof chat;
    const internals = client as unknown as {
      activeChat: ChatState | null;
      recoverDroppedTurn: (chat: ChatState, requestId: string) => Promise<void>;
    };
    internals.activeChat = chat;
    vi.spyOn(client, 'rehydrateChat').mockResolvedValue({
      sessionId: 'room-1', visitorId: 'visitor-1', participants: [],
      endedAt: '2026-09-22T10:00:00.000Z',
      messages: [{ id: 'm2', sender: 'writer', body: 'See you next time.', ts: '2026-09-22T09:59:59.000Z', attachments: [] }],
      responses: [{ requestId: 'r1', completed: true }],
    });
    const recovery = internals.recoverDroppedTurn(chat, 'r1');
    await vi.runAllTimersAsync();
    await recovery;
    expect(EventBus.emit).toHaveBeenCalledWith('chat-delta', expect.objectContaining({ npcId: 'writer', text: 'See you next time.' }));
    expect(EventBus.emit).toHaveBeenCalledWith('chat-ended', expect.objectContaining({ sessionId: 'room-1' }));
    expect(EventBus.emit).not.toHaveBeenCalledWith('chat-participants', expect.anything());
    expect(internals.activeChat).toBeNull();
    expect(chat.streamSettled).toBe(true);
  });
});
