import { describe, it, expect, beforeEach } from "vitest";
import {
  checkFixtureAction,
  tryRecordEffect,
  _resetEffectLimiter,
  type FixtureDef,
} from "./fixtures.js";

// The office fixtures as seeded (design doc §4): a whitelisted phone + decorative
// fixtures with no actions.
const OFFICE: FixtureDef[] = [
  { id: "outbox", kind: "mail" },
  { id: "desk", kind: "workstation" },
  { id: "phone", kind: "device", actions: ["ring"] },
];

describe("checkFixtureAction whitelist (design doc §4)", () => {
  it("accepts a whitelisted action on a present fixture", () => {
    const r = checkFixtureAction(OFFICE, "phone", "ring", "The Office");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fixture.id).toBe("phone");
      expect(r.action).toBe("ring");
    }
  });

  it("rejects an action not in the fixture whitelist, listing what's allowed", () => {
    const r = checkFixtureAction(OFFICE, "phone", "smash", "The Office");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/can't smash/i);
      expect(r.reason).toMatch(/ring/);
    }
  });

  it("rejects a fixture that isn't here, listing what is", () => {
    const r = checkFixtureAction(OFFICE, "espresso machine", "hiss", "The Office");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no espresso machine here/i);
  });

  it("rejects a decorative fixture with no actions", () => {
    const r = checkFixtureAction(OFFICE, "desk", "wobble", "The Office");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/just sits there/i);
  });

  it("treats a missing actions array as no actions", () => {
    const fixtures: FixtureDef[] = [{ id: "fountain" }];
    const r = checkFixtureAction(fixtures, "fountain", "splash", "Town Square");
    expect(r.ok).toBe(false);
  });
});

describe("effect rate limiter (3/hour per agent, design doc §4/§7)", () => {
  beforeEach(() => _resetEffectLimiter());

  it("allows 3 effects in a window then blocks the 4th", () => {
    const now = 1_000_000;
    expect(tryRecordEffect("hobby", now)).toBe(true);
    expect(tryRecordEffect("hobby", now + 1)).toBe(true);
    expect(tryRecordEffect("hobby", now + 2)).toBe(true);
    expect(tryRecordEffect("hobby", now + 3)).toBe(false);
  });

  it("does not record a blocked attempt (no permanent lockout)", () => {
    const now = 1_000_000;
    tryRecordEffect("writer", now);
    tryRecordEffect("writer", now + 1);
    tryRecordEffect("writer", now + 2);
    // Blocked — and the rejection must NOT push a timestamp, so once the window
    // rolls forward the agent is back to a clean slate, not perpetually capped.
    expect(tryRecordEffect("writer", now + 3)).toBe(false);
    const later = now + 60 * 60_000 + 10; // just past the 1h window
    expect(tryRecordEffect("writer", later)).toBe(true);
  });

  it("expires timestamps outside the rolling hour", () => {
    const base = 1_000_000;
    tryRecordEffect("builder", base);
    tryRecordEffect("builder", base + 1);
    tryRecordEffect("builder", base + 2);
    // 2 of the 3 fall outside the window an hour and a bit later; the agent has
    // headroom again.
    const t = base + 60 * 60_000 + 5;
    expect(tryRecordEffect("builder", t)).toBe(true);
  });

  it("tracks agents independently", () => {
    const now = 1_000_000;
    tryRecordEffect("career", now);
    tryRecordEffect("career", now + 1);
    tryRecordEffect("career", now + 2);
    expect(tryRecordEffect("career", now + 3)).toBe(false);
    // A different agent is unaffected.
    expect(tryRecordEffect("researcher", now + 3)).toBe(true);
  });
});
