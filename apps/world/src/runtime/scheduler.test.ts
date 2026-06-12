import { describe, it, expect } from "vitest";
import { decideBoost } from "./scheduler.js";

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
