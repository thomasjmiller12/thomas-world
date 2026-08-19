// The persistent per-agent thread (M3 continuity). Each agent has ONE
// continuous conversation, stored in the provider's native item format. The
// provider adapter loads it to resume, accumulates the turn, and we re-persist
// after every SUCCESSFUL turn. A crash mid-turn leaves
// the prior thread intact; the triggering input simply retries.
//
// Storage is a JSONB blob (verified to round-trip cleanly). The thread holds
// only the message history — the soul/protocol live in the cached system prefix
// (added at call time), and core memory is folded into each turn's delta, so
// neither lives here.

import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import type { LlmProviderName } from "../runtime/llm/types.js";
import { coreMemorySnapshot } from "./memory.js";
import { listArtifacts } from "./artifacts.js";

const { agentThreads } = schema;

export interface LoadedThread {
  // The persisted message history. Empty array = a fresh (or just-reseeded)
  // thread; the loop orients it with buildSeedContext() on its first turn.
  items: unknown[];
  // High-water world-event id already folded in as notice-push. null = nothing
  // perceived yet (a fresh thread perceives from "now" on its first turn).
  inputCursor: number | null;
}

// Load an agent's thread. Returns an empty thread if none exists yet.
export async function loadThread(
  agentId: AgentId,
  provider: LlmProviderName,
): Promise<LoadedThread> {
  const [row] = await db
    .select()
    .from(agentThreads)
    .where(and(eq(agentThreads.agentId, agentId), eq(agentThreads.provider, provider)));
  if (!row) return { items: [], inputCursor: null };
  return {
    items: row.content ?? [],
    inputCursor: row.inputCursor ?? null,
  };
}

// Persist the thread after a successful turn (upsert). Call ONLY on success so
// a crashed turn leaves the prior state intact.
export async function persistThread(
  agentId: AgentId,
  provider: LlmProviderName,
  items: unknown[],
  inputCursor: number | null,
): Promise<void> {
  await db
    .insert(agentThreads)
    .values({ agentId, provider, content: items, inputCursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [agentThreads.agentId, agentThreads.provider],
      set: { content: items, inputCursor, updatedAt: new Date() },
    });
}

// Reset a thread to empty — the corruption-recovery action and the clean-start
// action. The next turn re-orients via buildSeedContext(). Keeps the row (cursor
// cleared) so a fresh thread perceives from "now", not the whole backlog.
export async function reseedThread(
  agentId: AgentId,
  provider: LlmProviderName,
): Promise<void> {
  await persistThread(agentId, provider, [], null);
}

// Orientation for a fresh/reseeded thread's FIRST turn: the agent's durable
// anchors (core memory) + its most recent diary, so a (re)started agent picks
// up its life with continuity rather than amnesia. Folded into the first delta
// by the loop; not stored in the thread (it's a one-time orientation, and core
// memory rides every delta anyway).
export async function buildSeedContext(agentId: AgentId): Promise<string> {
  const [core, diaries] = await Promise.all([
    coreMemorySnapshot(agentId),
    listArtifacts({ kind: "diary_entry", agent: agentId }, 1),
  ]);
  const lastDiary = diaries[0];
  const diaryBit = lastDiary
    ? `Your most recent diary entry — "${lastDiary.title}":\n${lastDiary.body}`
    : "(You haven't written a diary yet.)";
  return [
    "You're picking up the continuous thread of your life in the town. Everything before this point is folded into your memory below — read it as your own recent past, not a briefing from someone else.",
    "",
    "Your core memory (durable anchors — who you are, what you're focused on):",
    core,
    "",
    diaryBit,
  ].join("\n");
}
