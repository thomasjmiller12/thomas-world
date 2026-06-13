import { describe, it, expect } from "vitest";
import { decideBoost } from "./scheduler.js";

// M3 note: the say-boost timer is gone — room-talk reaction is now an interrupt
// tick the loop enqueues when a co-located facet is addressed by name. decideBoost
// still backs the VISITOR-presence boost; the cases below exercise its pure
// throttle/clamp logic (including the optional bands the old say-boost used).
const SAY_THROTTLE_MS = 90_000;
const SAY_FLOOR = 20_000;
const SAY_MAX = 45_000;

// Pure boost-decision logic (design doc §2/§7). The DB/timer wiring in
// boostAgent is integration-bound; the throttle + clamp rules are pure here.
describe("decideBoost — co-located tick boost throttle + clamp", () => {
  const now = 1_000_000_000_000;

  it("throttles a second boost within 5 min for the same (visitor, agent)", () => {
    const d = decideBoost({
      now,
      lastBoostAt: now - 4 * 60_000, // 4 min ago — inside the 5-min window
      remainingMs: 10 * 60_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
    });
    expect(d.boost).toBe(false);
    expect(d.reason).toBe("throttled");
  });

  it("allows a boost once the 5-min throttle window has passed", () => {
    const d = decideBoost({
      now,
      lastBoostAt: now - 6 * 60_000, // 6 min ago — outside the window
      remainingMs: 10 * 60_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
    });
    expect(d.boost).toBe(true);
  });

  it("allows the first-ever boost (no prior timestamp)", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 10 * 60_000,
      maxDelayMs: 60_000,
      jitterMs: 15_000,
    });
    expect(d.boost).toBe(true);
    // floor 30s + jitter 15s = 45s, under the 60s cap and under the 10-min remaining.
    expect(d.delayMs).toBe(45_000);
  });

  it("clamps to the 30–60s band (never below the 30s floor)", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 10 * 60_000,
      maxDelayMs: 60_000,
      jitterMs: 0,
    });
    expect(d.delayMs).toBe(30_000);
  });

  it("never delays a tick already due sooner than the boost target", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 12_000, // already due in 12s
      maxDelayMs: 60_000,
      jitterMs: 20_000, // target would be 50s — but we must not push it out
    });
    expect(d.boost).toBe(true);
    expect(d.delayMs).toBe(12_000);
  });

  it("does not boost when there's no armed timer to pull forward", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: undefined,
      maxDelayMs: 60_000,
      jitterMs: 0,
    });
    expect(d.boost).toBe(false);
    expect(d.reason).toBe("no-timer");
  });
});

// Say-boost extends the same pure decideBoost with a tighter throttle window, a
// 20–45s band, and a per-location hourly storm cap (design doc §2).
describe("decideBoost — say-boost (room-talk wake)", () => {
  const now = 1_000_000_000_000;

  it("uses the explicit say throttle window (90s), not the default 5-min", () => {
    // 60s ago: inside the 90s say window → throttled, even though it's WELL past
    // the 5-min default that the visitor boost uses.
    const d = decideBoost({
      now,
      lastBoostAt: now - 60_000,
      remainingMs: 10 * 60_000,
      maxDelayMs: SAY_MAX,
      jitterMs: 0,
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
    });
    expect(d.boost).toBe(false);
    expect(d.reason).toBe("throttled");
  });

  it("allows a say-boost once the 90s pair window has passed", () => {
    const d = decideBoost({
      now,
      lastBoostAt: now - 91_000,
      remainingMs: 10 * 60_000,
      maxDelayMs: SAY_MAX,
      jitterMs: 0,
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
    });
    expect(d.boost).toBe(true);
  });

  it("clamps to the 20s floor at the bottom of the say band", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 10 * 60_000,
      maxDelayMs: SAY_MAX,
      jitterMs: 0,
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
    });
    expect(d.delayMs).toBe(SAY_FLOOR);
  });

  it("caps at the 45s max of the say band even with large jitter", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 10 * 60_000,
      maxDelayMs: SAY_MAX,
      jitterMs: 60_000, // floor+jitter would be 80s — clamp to the 45s max
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
    });
    expect(d.delayMs).toBe(SAY_MAX);
  });

  it("falls back to natural cadence once the location budget is spent", () => {
    // The location-budget cap is checked FIRST and beats the (passed) throttle.
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 10 * 60_000,
      maxDelayMs: SAY_MAX,
      jitterMs: 0,
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
      locationBudgetExceeded: true,
    });
    expect(d.boost).toBe(false);
    expect(d.reason).toBe("location-budget");
  });

  it("never delays a say-target's tick already due sooner than the band floor", () => {
    const d = decideBoost({
      now,
      lastBoostAt: undefined,
      remainingMs: 8_000, // due in 8s, under the 20s floor
      maxDelayMs: SAY_MAX,
      jitterMs: 10_000,
      floorMs: SAY_FLOOR,
      throttleMs: SAY_THROTTLE_MS,
    });
    expect(d.boost).toBe(true);
    expect(d.delayMs).toBe(8_000);
  });
});
