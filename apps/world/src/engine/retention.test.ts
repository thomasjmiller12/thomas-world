import { describe, it, expect } from "vitest";
import {
  llmUsageCutoff,
  threadSummaryCutoffDay,
  aggregateUsageRows,
  SYSTEM_AGENT_KEY,
  type UsageRow,
} from "./retention.js";

// Pure decision-logic tests for the retention sweep (engine/retention.ts). The
// DB-touching half (rollupAndPruneLlmUsage / pruneThreadSummaries /
// runRetentionSweep) is exercised against a real Postgres as part of the
// migration verification (see apps/world/drizzle) rather than mocked here —
// what's worth unit-testing without a database is exactly the in/out-of-window
// math and the aggregation grouping, which is what a silent off-by-one here
// would get wrong (either pruning today's spend or leaking a stale bucket).

describe("llmUsageCutoff", () => {
  it("lands exactly on start-of-today when retentionDays is 0", () => {
    const now = new Date("2026-07-30T14:32:00Z");
    const cutoff = llmUsageCutoff(now, 0);
    expect(cutoff.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("subtracts whole UTC days for a positive window", () => {
    const now = new Date("2026-07-30T14:32:00Z");
    const cutoff = llmUsageCutoff(now, 30);
    // start-of-today (2026-07-30T00:00:00Z) minus 30 days.
    expect(cutoff.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("never moves the cutoff into today, even for a negative/garbage config value", () => {
    const now = new Date("2026-07-30T14:32:00Z");
    const cutoff = llmUsageCutoff(now, -5);
    // Clamped to 0 — the cutoff is still start-of-today, never later.
    expect(cutoff.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("is insensitive to the time of day `now` falls on (always UTC midnight)", () => {
    const earlyMorning = llmUsageCutoff(new Date("2026-07-30T00:00:01Z"), 7);
    const lateNight = llmUsageCutoff(new Date("2026-07-30T23:59:59Z"), 7);
    expect(earlyMorning.toISOString()).toBe(lateNight.toISOString());
  });
});

describe("llmUsageCutoff never reaches into \"today\" (the spend-ledger invariant)", () => {
  it("keeps every row whose ts is >= start-of-today for any configured window", () => {
    const now = new Date("2026-07-30T09:00:00Z");
    const startOfToday = new Date("2026-07-30T00:00:00Z").getTime();
    for (const days of [0, 1, 7, 30, 365, -100]) {
      const cutoff = llmUsageCutoff(now, days);
      // The sweep's delete condition is `ts < cutoff` — so a row with
      // ts === startOfToday must never satisfy `ts < cutoff`.
      expect(cutoff.getTime()).toBeLessThanOrEqual(startOfToday);
    }
  });
});

describe("threadSummaryCutoffDay", () => {
  it("subtracts whole days and formats as YYYY-MM-DD", () => {
    const now = new Date("2026-07-30T14:32:00Z");
    expect(threadSummaryCutoffDay(now, 45)).toBe("2026-06-15");
  });

  it("clamps a negative window to 0 days back (today's date string)", () => {
    const now = new Date("2026-07-30T14:32:00Z");
    expect(threadSummaryCutoffDay(now, -10)).toBe("2026-07-30");
  });

  it("crosses a UTC month/year boundary correctly", () => {
    const now = new Date("2026-01-05T00:00:00Z");
    expect(threadSummaryCutoffDay(now, 10)).toBe("2025-12-26");
  });
});

describe("aggregateUsageRows", () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({
    day: "2026-07-01",
    agentId: "hobby",
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estCostUsd: 0.01,
    ...over,
  });

  it("returns nothing for an empty batch", () => {
    expect(aggregateUsageRows([])).toEqual([]);
  });

  it("sums calls, tokens, and cost within one (day, agent, model) bucket", () => {
    const rows = [row({}), row({ inputTokens: 50, outputTokens: 5, estCostUsd: 0.005 }), row({})];
    const buckets = aggregateUsageRows(rows);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      day: "2026-07-01",
      agentId: "hobby",
      model: "claude-sonnet-5",
      calls: 3,
      inputTokens: 250,
      outputTokens: 25,
      estCostUsd: 0.025,
    });
  });

  it("keeps separate buckets per day, per agent, and per model", () => {
    const rows = [
      row({ day: "2026-07-01", agentId: "hobby" }),
      row({ day: "2026-07-02", agentId: "hobby" }), // different day
      row({ day: "2026-07-01", agentId: "career" }), // different agent
      row({ day: "2026-07-01", agentId: "hobby", model: "claude-haiku-4-5" }), // different model
    ];
    const buckets = aggregateUsageRows(rows);
    expect(buckets).toHaveLength(4);
    for (const b of buckets) expect(b.calls).toBe(1);
  });

  it("folds a null agentId (system/Crier calls) under SYSTEM_AGENT_KEY, not a literal null bucket", () => {
    const rows = [row({ agentId: null }), row({ agentId: null })];
    const buckets = aggregateUsageRows(rows);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].agentId).toBe(SYSTEM_AGENT_KEY);
    expect(buckets[0].calls).toBe(2);
  });

  it("does not collapse two agents that merely share a day+model (bucket key is unambiguous)", () => {
    // A key built with naive string concatenation ("2026-07-01" + "hobby" +
    // model) could theoretically collide with a differently-split day/agent
    // string; this guards the actual separator-based key stays unambiguous.
    const rows = [
      row({ day: "2026-07-01", agentId: "hobby" }),
      row({ day: "2026-07-01", agentId: "career" }),
    ];
    const buckets = aggregateUsageRows(rows);
    const agents = buckets.map((b) => b.agentId).sort();
    expect(agents).toEqual(["career", "hobby"]);
  });
});
