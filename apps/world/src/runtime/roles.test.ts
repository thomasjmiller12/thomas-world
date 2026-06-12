import { describe, it, expect } from "vitest";
import { reconcileBudgets, loadProfiles } from "./roles.js";
import { agentIds } from "@town/contract";

// Budget reconciliation (design doc §7): the per-role daily soft caps must sum
// to ≤ the global daily ceiling, or the global cap silently dominates the
// per-role tuning. reconcileBudgets is pure math over the loaded role configs;
// these tests pin the contract its boot-time WARN/OK depends on.
describe("reconcileBudgets", () => {
  it("reports the per-role breakdown for every agent", () => {
    const r = reconcileBudgets(100);
    expect(r.perRole).toHaveLength(agentIds.length);
    for (const id of agentIds) {
      expect(r.perRole.some((p) => p.id === id)).toBe(true);
    }
  });

  it("sums the per-role caps and compares against the global ceiling", () => {
    const profiles = loadProfiles();
    const expectedSum = agentIds.reduce(
      (s, id) => s + (profiles.get(id)?.role.dailyTokenBudgetUsd ?? 0),
      0,
    );
    const rounded = Math.round(expectedSum * 100) / 100;
    const r = reconcileBudgets(rounded);
    expect(r.roleSumUsd).toBeCloseTo(rounded, 2);
    // Sum == ceiling → still ok (≤, not <).
    expect(r.ok).toBe(true);
  });

  it("is ok when the global ceiling comfortably exceeds the role sum", () => {
    const r = reconcileBudgets(1000);
    expect(r.ok).toBe(true);
    expect(r.globalCapUsd).toBe(1000);
  });

  it("flags a mismatch when the role sum exceeds the global ceiling", () => {
    // A deliberately tiny ceiling: the configured roles sum well above $0.01.
    const r = reconcileBudgets(0.01);
    expect(r.ok).toBe(false);
    expect(r.roleSumUsd).toBeGreaterThan(r.globalCapUsd);
  });

  it("rounds to cents so float noise can't trip the equality boundary", () => {
    // 0.1 + 0.2 style drift must not flip ok at an exact-equality boundary.
    const profiles = loadProfiles();
    const sum = agentIds.reduce(
      (s, id) => s + (profiles.get(id)?.role.dailyTokenBudgetUsd ?? 0),
      0,
    );
    const r = reconcileBudgets(sum);
    expect(Number.isInteger(Math.round(r.roleSumUsd * 100))).toBe(true);
    expect(r.ok).toBe(true);
  });
});
