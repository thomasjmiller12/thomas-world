// Retention sweep for the tables nothing else ever prunes (housekeeping,
// 2026-07-30). Row counts at the time this was written: llm_usage 7,207,
// world_events 4,411, thread_summaries 118, artifact_state 46 — none of them
// shrink on their own, and llm_usage sits on the hot path: `spendTodayUsd` /
// `spendTodayForAgent` (engine/usage.ts) run before EVERY tick, and the chat
// budget gate (`chatBudgetBlocked`, runtime/loop.ts) runs before every visitor
// turn. Five agents ticking every ~45 min forever is an unbounded row count
// with no cap in sight.
//
// Table-by-table decisions:
//
//  - llm_usage IS the spend ledger. `spendTodayUsd`/`spendTodayForAgent` only
//    ever read rows with `ts >= start of today (UTC)`. This sweep only ever
//    deletes rows STRICTLY OLDER than a UTC-day cutoff computed from
//    start-of-today (see `llmUsageCutoff`), so no configured retention window
//    can ever cause a "today" row to be deleted — today's spend stays
//    byte-for-byte exact by construction, not by a guard someone has to
//    remember at the call site. Before a row is deleted it is folded into
//    `llm_usage_daily` (day × agent × provider × model), so "what did last quarter cost"
//    survives after the raw per-call rows are gone. Default window: 30 days.
//
//  - world_events is the canonical, queryable record of the world's history —
//    the Chronicle and every agent's perception read it, and the 2026-07-30
//    quality pass explicitly kept `conversations`/`conversation_turns` as an
//    inert archive rather than delete real (if obsolete) town history.
//    **THIS SWEEP DOES NOT TOUCH world_events, at all.** Disk is cheap; a
//    visitor's or agent's history isn't recoverable once deleted. If
//    world_events ever needs to shrink, that should be a deliberate, separate
//    decision — never a side effect of a generic housekeeping timer.
//
//  - thread_summaries is a lazily-built Haiku summary cache keyed by calendar
//    `day` (chronicle.ts's `groupSpokeIntoThreads` + `summarizeThread`) — a
//    cache miss just regenerates it on the next Chronicle read, so it's safe
//    to expire outright with no rollup. Default window: 45 days.
//
//  - artifact_state is deliberately left alone (not configurable here at all).
//    It's live application state for interactive artifacts — a guestbook's
//    entries, a Go board's position — not a growing log, and it's already
//    bounded by hard per-artifact caps (engine/artifact-state.ts: ≤256 keys,
//    ≤32KB per value) rather than by time. A time-based sweep would just
//    delete a still-in-use app's data out from under it.

import { lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import type { LlmProviderName } from "../runtime/llm/types.js";

const { llmUsage, llmUsageDaily, threadSummaries } = schema;

// llm_usage rows recorded with no agentId (Town Crier / Chronicle-summary
// calls — see chronicle.ts / chronicle-issue.ts's `recordUsage({agentId: null,
// ...})`) roll up under this sentinel so the daily composite keys stay NOT NULL:
// Postgres NULLs never collide under
// `ON CONFLICT`, which would silently turn the upsert into an ever-growing set
// of duplicate "null" rows instead of one accumulating bucket.
export const SYSTEM_AGENT_KEY = "_system";

function dayStringUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The UTC-midnight boundary `retentionDays` back from `now`. llm_usage rows
// with `ts` older than this are eligible for rollup + delete. Because
// `spendTodayUsd` only reads `ts >= startOfTodayUtc()`, and this cutoff is
// ALWAYS at or before that same start-of-today (a `retentionDays` of 0 still
// lands exactly on it, and the delete condition below is a strict `<`), no
// value of `retentionDays` can ever reach into "today" — the safety is
// inherent to the formula.
export function llmUsageCutoff(now: Date, retentionDays: number): Date {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.max(0, retentionDays);
  return new Date(startOfToday - days * 86_400_000);
}

// Same idea for thread_summaries, but keyed by the `day` TEXT column
// (YYYY-MM-DD) rather than a timestamp — ISO day strings sort lexically, so
// the delete is a plain string comparison; no date parsing on the DB side.
export function threadSummaryCutoffDay(now: Date, retentionDays: number): string {
  const days = Math.max(0, retentionDays);
  return dayStringUtc(new Date(now.getTime() - days * 86_400_000));
}

export interface UsageRow {
  day: string; // YYYY-MM-DD, derived from the row's `ts`
  agentId: string | null;
  provider: LlmProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

export interface UsageBucket {
  day: string;
  agentId: string; // SYSTEM_AGENT_KEY substituted for a null agentId
  provider: LlmProviderName;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

// Pure aggregation: fold a batch of expired llm_usage rows into
// day×agent×provider×model buckets. Exported (and unit-tested without a
// database) so the grouping and boundary behavior is verifiable on its own —
// the DB-touching half
// (`rollupAndPruneLlmUsage` below) is a thin transactional shell around it.
export function aggregateUsageRows(rows: UsageRow[]): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const r of rows) {
    const agentId = r.agentId ?? SYSTEM_AGENT_KEY;
    const key = `${r.day}\u0000${agentId}\u0000${r.provider}\u0000${r.model}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.calls += 1;
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.cacheReadTokens += r.cacheReadTokens;
      existing.cacheWriteTokens += r.cacheWriteTokens;
      existing.estCostUsd += r.estCostUsd;
    } else {
      buckets.set(key, {
        day: r.day,
        agentId,
        provider: r.provider,
        model: r.model,
        calls: 1,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        estCostUsd: r.estCostUsd,
      });
    }
  }
  return [...buckets.values()];
}

export interface RollupResult {
  rowsDeleted: number;
  bucketsWritten: number;
}

// Roll up + delete every llm_usage row older than the retention window, inside
// one transaction — so a crash between the rollup write and the delete can
// never double-count a row on the next sweep. Each raw row is folded into
// llm_usage_daily and removed atomically, exactly once, ever; if a bucket
// already holds contributions from an earlier sweep, the upsert increments it
// rather than overwriting.
export async function rollupAndPruneLlmUsage(now: Date = new Date()): Promise<RollupResult> {
  const cutoff = llmUsageCutoff(now, config.retention.llmUsageDays);
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({
        ts: llmUsage.ts,
        agentId: llmUsage.agentId,
        provider: llmUsage.provider,
        model: llmUsage.model,
        inputTokens: llmUsage.inputTokens,
        outputTokens: llmUsage.outputTokens,
        cacheReadTokens: llmUsage.cacheReadTokens,
        cacheWriteTokens: llmUsage.cacheWriteTokens,
        estCostUsd: llmUsage.estCostUsd,
      })
      .from(llmUsage)
      .where(lt(llmUsage.ts, cutoff));
    if (expired.length === 0) return { rowsDeleted: 0, bucketsWritten: 0 };

    const buckets = aggregateUsageRows(
      expired.map((r) => ({
        ...r,
        provider: r.provider as LlmProviderName,
        day: dayStringUtc(r.ts),
      })),
    );
    for (const b of buckets) {
      await tx
        .insert(llmUsageDaily)
        .values({
          day: b.day,
          agentId: b.agentId,
          provider: b.provider,
          model: b.model,
          calls: b.calls,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheReadTokens: b.cacheReadTokens,
          cacheWriteTokens: b.cacheWriteTokens,
          estCostUsd: b.estCostUsd,
        })
        .onConflictDoUpdate({
          target: [
            llmUsageDaily.day,
            llmUsageDaily.agentId,
            llmUsageDaily.provider,
            llmUsageDaily.model,
          ],
          set: {
            calls: sql`${llmUsageDaily.calls} + ${b.calls}`,
            inputTokens: sql`${llmUsageDaily.inputTokens} + ${b.inputTokens}`,
            outputTokens: sql`${llmUsageDaily.outputTokens} + ${b.outputTokens}`,
            cacheReadTokens: sql`${llmUsageDaily.cacheReadTokens} + ${b.cacheReadTokens}`,
            cacheWriteTokens: sql`${llmUsageDaily.cacheWriteTokens} + ${b.cacheWriteTokens}`,
            estCostUsd: sql`${llmUsageDaily.estCostUsd} + ${b.estCostUsd}`,
            updatedAt: new Date(),
          },
        });
    }

    await tx.delete(llmUsage).where(lt(llmUsage.ts, cutoff));
    return { rowsDeleted: expired.length, bucketsWritten: buckets.length };
  });
}

// Expire thread_summaries older than the window — a pure cache, no rollup
// needed (a miss just regenerates on the next Chronicle read).
export async function pruneThreadSummaries(now: Date = new Date()): Promise<number> {
  const cutoffDay = threadSummaryCutoffDay(now, config.retention.threadSummaryDays);
  const deleted = await db
    .delete(threadSummaries)
    .where(lt(threadSummaries.day, cutoffDay))
    .returning({ threadId: threadSummaries.threadId });
  return deleted.length;
}

// Top-level sweep, wired into runtime/scheduler.ts's daily timer. Each half is
// independently try/caught so one failing never blocks the other and never
// throws into the caller — a scheduler timer must keep firing regardless of
// what a sweep run does.
export async function runRetentionSweep(now: Date = new Date()): Promise<void> {
  try {
    const { rowsDeleted, bucketsWritten } = await rollupAndPruneLlmUsage(now);
    if (rowsDeleted > 0) {
      console.log(
        `[retention] llm_usage: rolled up + deleted ${rowsDeleted} row(s) older than ` +
          `${config.retention.llmUsageDays}d into ${bucketsWritten} daily bucket(s).`,
      );
    }
  } catch (err) {
    console.warn("[retention] llm_usage sweep failed:", (err as Error).message);
  }

  try {
    const deleted = await pruneThreadSummaries(now);
    if (deleted > 0) {
      console.log(
        `[retention] thread_summaries: deleted ${deleted} row(s) older than ` +
          `${config.retention.threadSummaryDays}d (cache — regenerates lazily).`,
      );
    }
  } catch (err) {
    console.warn("[retention] thread_summaries sweep failed:", (err as Error).message);
  }
}
