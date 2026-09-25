import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArtifactTrail, submitContribution } from './contributions';

vi.mock('./mapping', () => ({ resolveWorldBaseUrl: () => 'https://world.test' }));
afterEach(() => vi.unstubAllGlobals());
function identity() {
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'town.visitorId' ? 'visitor' : 'secret-token' });
}

describe('explicit public contributions', () => {
  it('blocks observer submissions before consulting saved credentials or fetching', async () => {
    const getItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(submitContribution('artifact', 'suggestion', 'request', { readOnly: true })).rejects.toThrow('read-only');
    expect(fetch).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('makes observer reads public even when a visitor token is saved', async () => {
    identity();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ contributions: [], yours: [], revisions: [] }) });
    vi.stubGlobal('fetch', fetch);
    await fetchArtifactTrail('artifact', { readOnly: true });
    expect(String(fetch.mock.calls[0][0])).toBe('https://world.test/artifacts/artifact/trail');
    expect(fetch.mock.calls[0][1].headers).toEqual({});
  });

  it('keeps a caller UUID and literal text intact on the authenticated dedicated request', async () => {
    identity();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ message: 'Later' }) });
    vi.stubGlobal('fetch', fetch);
    await expect(submitContribution('game', '<b>Literal</b>', 'stable-retry-id', { readOnly: false })).rejects.toThrow('Later');
    expect(fetch).toHaveBeenCalledWith('https://world.test/artifacts/game/contributions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-visitor-token': 'secret-token' },
      body: JSON.stringify({ visitorId: 'visitor', requestId: 'stable-retry-id', text: '<b>Literal</b>' }),
    });
  });
});
