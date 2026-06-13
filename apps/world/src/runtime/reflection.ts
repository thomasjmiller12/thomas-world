// Nightly reflection ("sleep") — now a TURN ON THE CONTINUOUS THREAD (M3). The
// agent reviews its day (which is already in its thread — no day-record needs
// assembling), promotes stable patterns into core memory (via the memory tool),
// triggers Hindsight consolidation, and writes a short diary entry (itself feed
// content + the recovery seed). Runs once per agent overnight.
//
// The actual LLM turn goes through runTurn() (turn.js) so reflection happens
// WITHIN the agent's ongoing consciousness (and naturally lands a compaction at
// the day boundary). Reflection's turn is given ONLY the memory tool — it's
// introspective, not world-acting; the diary is its final text.
//
// Called by the loop's executor for a {kind:'reflection'} input, so the per-agent
// queue already serializes it — no separate lock/engagement guard needed.

import type { AgentId } from "@town/contract";
import { hasLlm } from "./client.js";
import { getProfile, soulGitHash } from "./roles.js";
import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
import {
  memView,
  memCreate,
  memStrReplace,
  memInsert,
  memDelete,
  memRename,
  coreMemorySnapshot,
} from "../engine/memory.js";
import { createArtifact, recentArtifactsBy } from "../engine/artifacts.js";
import { reflect as hindsightReflect } from "./hindsight.js";
import { startTrace } from "./tracing.js";
import { runTurn } from "./turn.js";
import { randomUUID } from "node:crypto";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";

const REFLECTION_PROMPT = `It's the end of the day in the town — your quiet hour.

Look back over your day (it's all in your memory above) and reflect:
- What actually happened, in your own read of it?
- Did anything shift in how you see things, what you're working on, or your
  relationships with the other facets?
- Is there a stable pattern worth promoting into your core memory (the
  always-loaded files) — or something stale in there to prune? Use the memory
  tool to keep core memory short, current, and true. Don't journal into it;
  core memory is for durable facts about who you are and what you're focused on.

Then write a short diary entry for today — a few honest sentences in your voice.
Return the diary entry as your final message (no tool call needed for it; just
write it as text). It'll be part of the day's record.`;

export async function runReflection(agentId: AgentId): Promise<{ ran: boolean }> {
  if (!hasLlm()) return { ran: false };
  // DB-grounded idempotency: one diary per night, regardless of process restarts
  // or partial-failure retries. The in-memory reflectedThisNight set resets on
  // every deploy, and a post-diary failure used to retry the WHOLE reflection —
  // Career once wrote four diaries in fourteen minutes. A diary in the last 8
  // hours (the window spans the midnight date flip) means this night's reflection
  // already happened: report ran so the scheduler marks it.
  const recentDiaries = await recentArtifactsBy(agentId, 8, "diary_entry");
  if (recentDiaries.length > 0) return { ran: true };
  return await runReflectionTurn(agentId);
}

async function runReflectionTurn(agentId: AgentId): Promise<{ ran: boolean }> {
  const profile = getProfile(agentId);
  const tickId = `reflect-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("reflection", {
    userId: agentId,
    sessionId: utcDay(),
    metadata: { soulGitHash: soulGitHash(agentId) },
  });

  // The reflection input. The day itself is ALREADY in the thread (M3) — we only
  // surface current core memory so the agent can curate it, then prompt the
  // reflection + diary. This is appended to the continuous thread by runTurn.
  const core = await coreMemorySnapshot(agentId);
  const inputText = [
    REFLECTION_PROMPT,
    ``,
    `## Your core memory right now`,
    core,
  ].join("\n");

  const memory = betaMemoryTool({
    view: (c) => memView(agentId, c.path),
    create: (c) => memCreate(agentId, c.path, c.file_text),
    str_replace: (c) => memStrReplace(agentId, c.path, c.old_str, c.new_str),
    insert: (c) => memInsert(agentId, c.path, c.insert_line, c.insert_text),
    delete: (c) => memDelete(agentId, c.path),
    rename: (c) => memRename(agentId, c.old_path, c.new_path),
  }) as unknown as BetaRunnableTool<unknown>;

  let diaryText = "";
  try {
    // Reflection runs as a turn on the continuous thread: introspective, memory
    // tool only, the diary is the final text. advanceCursorTo omitted → the
    // perception cursor is preserved (reflection perceives nothing new).
    const outcome = await runTurn({
      agentId,
      model: profile.role.tickModel,
      maxTokens: 2048,
      inputText,
      tools: [memory],
      tickId,
      trace,
    });
    if (!outcome.refused) diaryText = outcome.finalText;
  } catch (err) {
    console.warn(`[reflection ${agentId}] error:`, (err as Error).message);
    trace.end({ error: (err as Error).message });
    return { ran: false };
  }

  // Diary FIRST (it doubles as the idempotency marker), then consolidation —
  // and a Hindsight hiccup must never fail the reflection after the diary
  // landed (that ordering is what caused the multi-diary retry loop).
  if (diaryText) {
    const today = utcDay();
    await createArtifact({
      agentId,
      kind: "diary_entry",
      title: `Diary — ${today}`,
      body: diaryText,
    });
  }

  // Consolidate episodic memory (no-op when Hindsight off; best-effort always).
  try {
    await hindsightReflect(agentId);
  } catch (err) {
    console.warn(`[reflection ${agentId}] hindsight reflect failed:`, (err as Error).message);
  }

  trace.end({ wroteDiary: Boolean(diaryText) });
  return { ran: true };
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
