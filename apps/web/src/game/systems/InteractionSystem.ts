import { EventBus } from '../EventBus';
import { ThomasId, ChatMessage } from '@/lib/types';
import { NPC_CONFIGS } from '../data/npc-configs';

export class InteractionSystem {
  private activeChat: ThomasId | null = null;
  private responseIndex: Record<ThomasId, number> = {
    career: 0,
    researcher: 0,
    builder: 0,
    writer: 0,
    hobby: 0,
  };

  constructor() {
    EventBus.on('chat-message-sent', (data: { npcId: ThomasId; message: string }) => {
      this.handleVisitorMessage(data.npcId, data.message);
    });
  }

  private handleVisitorMessage(npcId: ThomasId, _message: string) {
    const config = NPC_CONFIGS[npcId];
    if (!config) return;

    // Simulate a brief delay before responding
    setTimeout(() => {
      const responses = config.stubbedResponses;
      const response = responses[this.responseIndex[npcId] % responses.length];
      this.responseIndex[npcId]++;

      const chatMessage: ChatMessage = {
        sender: npcId,
        senderName: config.displayName,
        text: response,
        timestamp: Date.now(),
      };

      EventBus.emit('npc-chat-response', chatMessage);
    }, 800 + Math.random() * 1200);
  }

  destroy() {
    EventBus.off('chat-message-sent');
  }
}
