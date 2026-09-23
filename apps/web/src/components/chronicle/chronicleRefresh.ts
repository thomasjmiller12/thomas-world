// One debounce policy for the town Chronicle and the observer dashboard.
const LIVE_TYPES = new Set([
  'agent.spoke', 'artifact.created', 'artifact.updated', 'message.sent',
  'bulletin.posted', 'capability.requested', 'capability.resolved', 'agent.acted',
  'conversation.started', 'conversation.turn', 'conversation.ended',
]);

export interface ChronicleRefreshState {
  day: string | null;
  resolvedDay: string;
  days: string[];
  readerOpen: boolean;
}

export function createChronicleRefresh(
  getState: () => ChronicleRefreshState,
  refresh: (latestDay: boolean) => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (getState().readerOpen || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const { day, resolvedDay, days, readerOpen } = getState();
      if (readerOpen) return;
      // Historical Today/Conversations stay fixed. Made/Board/Messages are not
      // day-scoped and should still refresh if a visitor previously chose a day.
      refresh(day === null || days.length === 0 || resolvedDay === days[0]);
    }, 4_000);
  };
  return {
    onWorldEvent: (event: { type: string }) => {
      if (LIVE_TYPES.has(event.type)) schedule();
    },
    onVisible: schedule,
    dispose: () => { if (timer) clearTimeout(timer); },
  };
}
