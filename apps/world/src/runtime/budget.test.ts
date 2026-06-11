import { describe, it, expect } from "vitest";
import { budgetExceeded } from "./tick.js";

describe("budget cap (brief §Observability & budget)", () => {
  const base = { globalCapUsd: 15, agentCapUsd: 1.5 };

  it("allows a tick when both global and per-agent spend are under cap", () => {
    expect(
      budgetExceeded({ ...base, globalSpendUsd: 5, agentSpendUsd: 0.5 }),
    ).toBe(false);
  });

  it("blocks when the per-agent soft cap is reached (status → sleeping)", () => {
    expect(
      budgetExceeded({ ...base, globalSpendUsd: 5, agentSpendUsd: 1.5 }),
    ).toBe(true);
  });

  it("blocks when the global daily ceiling is reached even if the agent is cheap", () => {
    expect(
      budgetExceeded({ ...base, globalSpendUsd: 15, agentSpendUsd: 0.1 }),
    ).toBe(true);
  });

  it("treats meeting the cap exactly as exceeded (>=)", () => {
    expect(
      budgetExceeded({
        globalCapUsd: 10,
        agentCapUsd: 2,
        globalSpendUsd: 10,
        agentSpendUsd: 0,
      }),
    ).toBe(true);
  });
});
