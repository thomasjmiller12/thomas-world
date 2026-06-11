// In-process pub/sub for live SSE fan-out. The event log (Postgres) is the
// durable source of truth; this bus is just the realtime push so connected
// browsers get events without polling. New subscribers replay from the log via
// Last-Event-ID, so a missed broadcast here is never lost.

import type { WorldEvent } from "@town/contract";

type Listener = (event: WorldEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let subscriberErrors = 0;
export function publish(event: WorldEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      // A slow/broken subscriber must never break the publisher — but a
      // systematically-throwing one (a bug in an SSE writer) would otherwise be
      // 100% invisible for the whole soak. Log the first, then periodically.
      subscriberErrors++;
      if (subscriberErrors === 1 || subscriberErrors % 100 === 0) {
        console.warn(
          `[bus] subscriber threw (${subscriberErrors} total):`,
          (err as Error).message,
        );
      }
    }
  }
}

export function subscriberCount(): number {
  return listeners.size;
}
