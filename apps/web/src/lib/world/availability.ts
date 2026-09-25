export type WorldAvailability = 'live' | 'reconnecting' | 'budget-asleep' | 'unavailable';

export function availabilityForTransport(
  authoritativeAwake: boolean | null,
  connected: boolean,
): WorldAvailability {
  if (authoritativeAwake === false) return 'budget-asleep';
  if (authoritativeAwake === true) return connected ? 'live' : 'reconnecting';
  return connected ? 'reconnecting' : 'unavailable';
}
