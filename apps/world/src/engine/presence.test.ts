import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPresenceTracker, type PresenceTracker } from "./visitors.js";

// The presence debounce exists because proxies recycle long-lived SSE
// connections (~15 min observed); each recycle used to emit a feed-visible
// left+arrived pair 3 seconds apart.

const GRACE = 60_000;
const WINDOW = 120_000;

describe("presence debounce", () => {
  let arrived: string[];
  let left: string[];
  let tracker: PresenceTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    arrived = [];
    left = [];
    tracker = createPresenceTracker({
      onArrive: async (id) => void arrived.push(id),
      onLeave: async (id) => void left.push(id),
      graceMs: GRACE,
      presenceWindowMs: WINDOW,
    });
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  it("emits arrived on a fresh connect and left after the grace window", async () => {
    await tracker.connected("v1", "Ada", null);
    expect(arrived).toEqual(["v1"]);
    tracker.disconnected("v1");
    expect(left).toEqual([]); // not yet — grace window pending
    await vi.advanceTimersByTimeAsync(GRACE + 1);
    expect(left).toEqual(["v1"]);
  });

  it("a transport recycle (disconnect + reconnect seconds later) emits nothing", async () => {
    await tracker.connected("v1", "Ada", null);
    arrived.length = 0;
    tracker.disconnected("v1");
    await vi.advanceTimersByTimeAsync(3_000); // observed reconnect gap
    await tracker.connected("v1", "Ada", new Date(Date.now() - 3_000));
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(arrived).toEqual([]);
    expect(left).toEqual([]);
  });

  it("a reconnect after a restart (recent lastSeenAt, no pending timer) is silent", async () => {
    // No prior state — simulates a fresh process. lastSeenAt is recent.
    await tracker.connected("v1", "Ada", new Date(Date.now() - 30_000));
    expect(arrived).toEqual([]);
  });

  it("a stale lastSeenAt outside the presence window is a real arrival", async () => {
    await tracker.connected("v1", "Ada", new Date(Date.now() - WINDOW - 1));
    expect(arrived).toEqual(["v1"]);
  });

  it("a second tab neither re-announces nor departs while the first is live", async () => {
    await tracker.connected("v1", "Ada", null);
    await tracker.connected("v1", "Ada", new Date());
    expect(arrived).toEqual(["v1"]); // once
    tracker.disconnected("v1"); // one tab closes
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(left).toEqual([]); // other tab still open
    tracker.disconnected("v1");
    await vi.advanceTimersByTimeAsync(GRACE + 1);
    expect(left).toEqual(["v1"]);
  });
});
