import { describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@town/contract';
import { createArtifactLoader } from './artifactLoader';

const artifact = (body: string): Artifact => ({
  id: 'shared-page', agentId: 'builder', kind: 'shared_page', title: 'Shared page', body,
  createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:01:00Z',
  locationId: 'workshop', fixture: null, published: true,
});
const deferred = () => {
  let resolve!: (value: Artifact) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Artifact>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const handlers = () => ({ onArtifact: vi.fn(), onLoading: vi.fn(), onError: vi.fn() });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('ArtifactReader request ordering', () => {
  it('keeps the live revision when the slow initial read returns afterward, even if it ignores abort', async () => {
    const old = deferred(); const live = deferred();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(live.promise);
    const on = handlers(); const loader = createArtifactLoader(fetch, on);
    loader.load();
    loader.load(true);
    expect(fetch.mock.calls[0][0].aborted).toBe(true);
    live.resolve(artifact('v2'));
    await settle();
    expect(on.onLoading).toHaveBeenLastCalledWith(false);
    old.resolve(artifact('v1'));
    await settle();
    expect(on.onArtifact).toHaveBeenCalledExactlyOnceWith(artifact('v2'));
    expect(on.onError).toHaveBeenLastCalledWith(false);
  });

  it('clears an initial error when a live update succeeds', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Initial failure')).mockResolvedValue(artifact('v2'));
    const on = handlers(); const loader = createArtifactLoader(fetch, on);
    loader.load();
    await settle();
    expect(on.onError).toHaveBeenLastCalledWith(true);
    loader.load(true);
    await settle();
    expect(on.onArtifact).toHaveBeenCalledExactlyOnceWith(artifact('v2'));
    expect(on.onError).toHaveBeenLastCalledWith(false);
    expect(on.onLoading).toHaveBeenLastCalledWith(false);
  });

  it('ignores a superseded retry failure after a live update succeeds', async () => {
    const retry = deferred();
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Initial failure'))
      .mockReturnValueOnce(retry.promise).mockResolvedValue(artifact('v2'));
    const on = handlers(); const loader = createArtifactLoader(fetch, on);
    loader.load();
    await settle();
    expect(on.onError).toHaveBeenLastCalledWith(true);
    loader.load();
    loader.load(true);
    await settle();
    retry.reject(new Error('Late retry failure'));
    await settle();
    expect(on.onArtifact).toHaveBeenCalledExactlyOnceWith(artifact('v2'));
    expect(on.onError).toHaveBeenLastCalledWith(false);
    expect(on.onLoading).toHaveBeenLastCalledWith(false);
  });

  it('keeps loaded content visible throughout a background refresh, including failure', async () => {
    const live = deferred();
    const fetch = vi.fn().mockResolvedValueOnce(artifact('v1')).mockReturnValueOnce(live.promise);
    const on = handlers(); const loader = createArtifactLoader(fetch, on);
    loader.load();
    await settle();
    on.onLoading.mockClear(); on.onError.mockClear();
    loader.load(true);
    expect(on.onLoading).not.toHaveBeenCalled();
    expect(on.onError).not.toHaveBeenCalled();
    live.reject(new Error('Temporary connection failure'));
    await settle();
    expect(on.onLoading).not.toHaveBeenCalledWith(true);
    expect(on.onError).not.toHaveBeenCalledWith(true);
    expect(on.onArtifact).toHaveBeenCalledExactlyOnceWith(artifact('v1'));
  });

  it('ignores responses after changing artifacts or closing the reader', async () => {
    const old = deferred(); const on = handlers();
    const loader = createArtifactLoader(() => old.promise, on);
    loader.load();
    loader.cancel();
    on.onLoading.mockClear(); on.onError.mockClear();
    old.resolve(artifact('v1'));
    await settle();
    expect(on.onArtifact).not.toHaveBeenCalled();
    expect(on.onLoading).not.toHaveBeenCalled();
    expect(on.onError).not.toHaveBeenCalled();
  });
});
