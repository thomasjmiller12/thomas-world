import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChronicleRefresh, type ChronicleRefreshState } from './chronicleRefresh';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const latest = (): ChronicleRefreshState => ({ day: null, resolvedDay: '2026-09-22', days: ['2026-09-22', '2026-09-21'], readerOpen: false });

describe('Chronicle live refresh on both surfaces', () => {
  it('coalesces content and conversation events but ignores ambient movement', () => {
    const refresh = vi.fn();
    const controller = createChronicleRefresh(latest, refresh);
    controller.onWorldEvent({ type: 'agent.moved' });
    vi.advanceTimersByTime(4_000);
    expect(refresh).not.toHaveBeenCalled();
    controller.onWorldEvent({ type: 'conversation.turn' });
    controller.onWorldEvent({ type: 'artifact.created' });
    controller.onWorldEvent({ type: 'message.sent' });
    vi.advanceTimersByTime(4_000);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('refreshes unscoped collections while leaving historical Chronicle days fixed', () => {
    const refresh = vi.fn();
    const controller = createChronicleRefresh(() => ({ ...latest(), day: '2026-09-21', resolvedDay: '2026-09-21' }), refresh);
    controller.onWorldEvent({ type: 'bulletin.posted' });
    vi.advanceTimersByTime(4_000);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('does not disrupt an open reader, checks current state after the debounce, and cancels on unmount', () => {
    let state = latest();
    const refresh = vi.fn();
    const controller = createChronicleRefresh(() => state, refresh);
    controller.onVisible();
    state = { ...state, readerOpen: true };
    vi.advanceTimersByTime(4_000);
    expect(refresh).not.toHaveBeenCalled();
    controller.onVisible();
    vi.advanceTimersByTime(4_000);
    expect(refresh).not.toHaveBeenCalled();
    state = { ...state, readerOpen: false };
    controller.onVisible();
    controller.dispose();
    vi.advanceTimersByTime(4_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
