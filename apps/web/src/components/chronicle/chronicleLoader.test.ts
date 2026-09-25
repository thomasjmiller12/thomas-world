import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChronicleLoader } from './chronicleLoader';
import type { ChroniclePage } from './chronicleClient';

const page = (pending: boolean, day = '2026-09-23'): ChroniclePage => ({ day, days: [day], items: [], issue: null, generationPending: pending });
const handlers = () => ({ onPage: vi.fn(), onLoading: vi.fn(), onError: vi.fn() });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('shared Chronicle loading for town and observer', () => {
  it('keeps following slow generation after seven seconds and stops on completion', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(true)).mockResolvedValue(page(false));
    const on = handlers(); const loader = createChronicleLoader(fetch, on);
    loader.load(null);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(on.onPage).toHaveBeenLastCalledWith(page(false));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('bounds fallback polling when generation never completes', async () => {
    const fetch = vi.fn().mockResolvedValue(page(true));
    const loader = createChronicleLoader(fetch, handlers());
    loader.load(null);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(6);
    // A later SSE completion can always refresh, even after fallback polling ends.
    fetch.mockResolvedValue(page(false));
    loader.load(null, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it('cancels old-day pending reads and timers on navigation and teardown', async () => {
    let resolve!: (p: ChroniclePage) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<ChroniclePage>(r => { resolve = r; })).mockResolvedValue(page(true, '2026-09-22'));
    const on = handlers(); const loader = createChronicleLoader(fetch, on);
    loader.load(null);
    loader.load('2026-09-22');
    resolve(page(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(on.onPage).toHaveBeenCalledExactlyOnceWith(page(true, '2026-09-22'));
    loader.cancel();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
