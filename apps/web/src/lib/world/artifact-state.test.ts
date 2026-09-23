import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArtifactState, putArtifactStateKey } from './artifact-state';

vi.mock('@/lib/world/mapping', () => ({ resolveWorldBaseUrl: () => 'https://world.test' }));

afterEach(() => vi.unstubAllGlobals());

function savedIdentity() {
  const entries: Record<string, string> = { 'town.visitorId': 'saved-visitor', 'town.visitorToken': 'saved-token' };
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries[key] ?? null });
}

describe('artifact state observer mode', () => {
  it('refuses writes before reading saved credentials or calling the server', async () => {
    savedIdentity();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await putArtifactStateKey('game', 'score', 5, { readOnly: true })).toEqual({
      ok: false, message: 'Observer mode is read-only',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves authenticated writes for an active visitor', async () => {
    savedIdentity();
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    expect(await putArtifactStateKey('game', 'score', 5, { readOnly: false })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://world.test/artifacts/game/state/score', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-visitor-token': 'saved-token' },
      body: JSON.stringify({ visitorId: 'saved-visitor', value: 5 }),
    });
  });

  it('keeps public state reads identity-free', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ artifactId: 'game', state: { score: 5 } }) });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchArtifactState('game')).toEqual({ score: 5 });
    expect(fetch).toHaveBeenCalledWith('https://world.test/artifacts/game/state', { signal: undefined });
  });
});
