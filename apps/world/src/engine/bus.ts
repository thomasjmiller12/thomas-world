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

export function publish(event: WorldEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // A slow/broken subscriber must never break the publisher.
    }
  }
}

export function subscriberCount(): number {
  return listeners.size;
}
