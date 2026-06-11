// LLM usage meter + daily budget (brief §"Observability & budget"). The
// runtime phase records per-call rows; M1 ships the table + read helpers so the
// /debug page can show spend today and the scheduler can enforce the cap.

import { and, gte, sql, eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";

const { llmUsage } = schema;

export interface RecordUsageInput {
  agentId?: AgentId | null;
  model: string;
  tickId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estCostUsd?: number;
}

export async function recordUsage(u: RecordUsageInput): Promise<void> {
  await db.insert(llmUsage).values({
    agentId: u.agentId ?? null,
    model: u.model,
    tickId: u.tickId ?? null,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    estCostUsd: u.estCostUsd ?? 0,
  });
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Total estimated spend (USD) since UTC midnight.
export async function spendTodayUsd(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.estCostUsd}), 0)` })
    .from(llmUsage)
    .where(gte(llmUsage.ts, startOfTodayUtc()));
  return Number(row?.total ?? 0);
}

// Per-agent spend today (for per-role budget caps).
export async function spendTodayForAgent(agentId: AgentId): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.estCostUsd}), 0)` })
    .from(llmUsage)
    .where(and(gte(llmUsage.ts, startOfTodayUtc()), eq(llmUsage.agentId, agentId)));
  return Number(row?.total ?? 0);
}
