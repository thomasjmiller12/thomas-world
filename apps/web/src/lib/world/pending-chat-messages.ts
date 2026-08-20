export interface PendingChatMessage<TAgentId extends string = string> {
  agentId: TAgentId;
  text: string;
}

// Visitor lines render optimistically, so every accepted line must also survive
// locally until its POST-SSE turn begins. A FIFO keeps the UI and server transcript
// in the same order when someone sends several thoughts during a slow reply.
export class PendingChatMessages<TAgentId extends string = string> {
  private readonly items: PendingChatMessage<TAgentId>[] = [];

  enqueue(message: PendingChatMessage<TAgentId>): void {
    this.items.push(message);
  }

  dequeue(): PendingChatMessage<TAgentId> | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }
}
