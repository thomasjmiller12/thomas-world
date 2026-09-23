// One lifecycle/director lane per room. The Railway world server is a monolith,
// so an in-process tail is sufficient to serialize speech, joins, travel,
// visitor close, and stale cleanup around the same durable session row.
const sessionTails = new Map<string, Promise<void>>();

export async function withRoomLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(sessionId) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => (unlock = resolve));
  const tail = previous.catch(() => undefined).then(() => gate);
  sessionTails.set(sessionId, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    unlock();
    if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId);
  }
}
