import { describe, expect, it } from 'vitest';
import { CreateContributionRequest, RespondToContributionInput } from './contributions.js';

describe('public contribution boundaries', () => {
  it('requires bounded nonblank text and two valid UUIDs without private flags', () => {
    const base = { visitorId: '3c44b923-1ec1-4b14-92a5-cd2d6bbd5f3c', requestId: '52101630-e98b-43c1-9de6-0d17a1c93947', text: '<script>literal</script>' };
    expect(CreateContributionRequest.parse(base).text).toBe(base.text);
    for (const patch of [{ text: ' ' }, { text: 'a'.repeat(2001) }, { requestId: 'a' }, { public: false }]) {
      expect(CreateContributionRequest.safeParse({ ...base, ...patch }).success).toBe(false);
    }
  });
  it('requires a concrete response for every status and refuses pending as a response', () => {
    const base = { contributionId: '3c44b923-1ec1-4b14-92a5-cd2d6bbd5f3c', status: 'completed', response: 'Added a reset button.' };
    expect(RespondToContributionInput.safeParse(base).success).toBe(true);
    expect(RespondToContributionInput.safeParse({ ...base, response: ' ' }).success).toBe(false);
    expect(RespondToContributionInput.safeParse({ ...base, status: 'pending' }).success).toBe(false);
  });
});
