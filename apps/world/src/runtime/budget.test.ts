import { describe, it, expect } from "vitest";
import { budgetExceeded, chatBudgetBlocked } from "./loop.js";

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

// Until 2026-07-30 `budgetExceeded` was checked ONLY on the tick path, so
// DAILY_BUDGET_USD was not actually a ceiling: visitor chat runs on the expensive
// chat model and was completely ungated. The rate limiters bound throughput, not
// spend — 150 chat messages/day/IP at ~$0.05–0.25 a turn is ~$7–37 from a single
// IP, with nothing stopping several IPs stacking.
describe("chat budget gate", () => {
  it("blocks conversation once the GLOBAL ceiling is reached", () => {
    expect(chatBudgetBlocked({ globalSpendUsd: 25, globalCapUsd: 25 })).toBe(true);
    expect(chatBudgetBlocked({ globalSpendUsd: 30, globalCapUsd: 25 })).toBe(true);
  });

  it("allows conversation while under the global ceiling", () => {
    expect(chatBudgetBlocked({ globalSpendUsd: 24.99, globalCapUsd: 25 })).toBe(false);
    expect(chatBudgetBlocked({ globalSpendUsd: 0, globalCapUsd: 25 })).toBe(false);
  });

  it("does NOT consider the per-role soft cap — a facet is never silenced for the day", () => {
    // This is the deliberate difference from the tick rule. A per-role overage
    // paces autonomous ticks; it must not make a facet refuse to talk to someone
    // standing in front of it. Same inputs that block a TICK must allow CHAT.
    const perRoleBlown = { globalSpendUsd: 5, globalCapUsd: 25, agentSpendUsd: 99, agentCapUsd: 4.5 };
    expect(budgetExceeded(perRoleBlown)).toBe(true);
    expect(chatBudgetBlocked(perRoleBlown)).toBe(false);
  });
});
