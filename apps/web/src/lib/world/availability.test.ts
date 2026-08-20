import { describe, expect, it } from 'vitest';
import { availabilityForTransport } from './availability';

describe('world availability truth', () => {
  it('never lets transport traffic wake a budget-sleeping snapshot', () => {
    expect(availabilityForTransport(false, true)).toBe('budget-asleep');
    expect(availabilityForTransport(false, false)).toBe('budget-asleep');
  });

  it('keeps unknown snapshot state distinct from a live town', () => {
    expect(availabilityForTransport(null, true)).toBe('reconnecting');
    expect(availabilityForTransport(null, false)).toBe('unavailable');
  });
});
