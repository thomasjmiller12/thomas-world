import { describe, it, expect, beforeEach } from "vitest";
import { shouldCueOwner, _resetCueThrottleForTest } from "./artifact-state.js";

// The owner-cue throttle is the piece that keeps a busy app (a Go game mid-
// flurry) from flooding the owner's queue with noted — uncoalesceable — ticks.
describe("shouldCueOwner — per-artifact throttle", () => {
  beforeEach(() => _resetCueThrottleForTest());

  it("first write cues; writes inside the window don't; the window re-opens", () => {
    expect(shouldCueOwner("a1", 1_000)).toBe(true);
    expect(shouldCueOwner("a1", 30_000)).toBe(false);
    expect(shouldCueOwner("a1", 89_000)).toBe(false);
    expect(shouldCueOwner("a1", 92_000)).toBe(true);
  });

  it("throttles per artifact, not globally", () => {
    expect(shouldCueOwner("a1", 1_000)).toBe(true);
    expect(shouldCueOwner("a2", 2_000)).toBe(true);
    expect(shouldCueOwner("a1", 3_000)).toBe(false);
    expect(shouldCueOwner("a2", 4_000)).toBe(false);
  });
});
