import { describe, it, expect, beforeEach } from "vitest";
import type { AgentId } from "@town/contract";
import { tryRecordEffect, _resetEffectLimiter } from "./fixtures.js";

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
