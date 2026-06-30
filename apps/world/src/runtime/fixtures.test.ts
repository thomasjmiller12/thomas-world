import { describe, it, expect, beforeEach } from "vitest";
import type { AgentId } from "@town/contract";
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

describe("effect rate limiter (20/hour per agent, raised from 3 for beats)", () => {
  beforeEach(() => _resetEffectLimiter());

  // The cap (fixtures.ts MAX_PER_WINDOW). Tests fill to the cap via a loop so
  // they track the constant rather than hardcoding it in many places.
  const CAP = 20;
  const fill = (agent: AgentId, base: number, n: number) => {
    for (let i = 0; i < n; i++) expect(tryRecordEffect(agent, base + i)).toBe(true);
  };

  it("allows CAP effects in a window then blocks the next", () => {
    const now = 1_000_000;
    fill("hobby", now, CAP);
    expect(tryRecordEffect("hobby", now + CAP)).toBe(false);
  });

  it("does not record a blocked attempt (no permanent lockout)", () => {
    const now = 1_000_000;
    fill("writer", now, CAP);
    // Blocked — and the rejection must NOT push a timestamp, so once the window
    // rolls forward the agent is back to a clean slate, not perpetually capped.
    expect(tryRecordEffect("writer", now + CAP)).toBe(false);
    const later = now + 60 * 60_000 + 10; // just past the 1h window
    expect(tryRecordEffect("writer", later)).toBe(true);
  });

  it("expires timestamps outside the rolling hour", () => {
    const base = 1_000_000;
    fill("builder", base, CAP);
    // The whole window falls outside an hour and a bit later; full headroom again.
    const t = base + 60 * 60_000 + CAP;
    expect(tryRecordEffect("builder", t)).toBe(true);
  });

  it("tracks agents independently", () => {
    const now = 1_000_000;
    fill("career", now, CAP);
    expect(tryRecordEffect("career", now + CAP)).toBe(false);
    // A different agent is unaffected.
    expect(tryRecordEffect("researcher", now + CAP)).toBe(true);
  });
});
