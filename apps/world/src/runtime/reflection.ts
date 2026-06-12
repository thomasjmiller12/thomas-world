// Nightly reflection ("sleep") tick (plan §4.1). Lighter than a normal tick:
// the agent reviews its day, promotes stable patterns into core memory (via the
// memory tool), triggers Hindsight consolidation, and writes a short diary
// entry (which is itself feed content). Runs once per agent overnight.
//
// Reflection gets ONLY the memory tool + create_artifact-equivalent (we write
// the diary directly here) — it's introspective, not world-acting.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AgentId } from "@town/contract";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS } from "./client.js";
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
import { recentEventsForAgent } from "../engine/events.js";
import { getAgent, isBusy } from "../engine/agents.js";
import { createArtifact } from "../engine/artifacts.js";
import { tryAcquire } from "./agent-lock.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { reflect as hindsightReflect } from "./hindsight.js";
import { startTrace } from "./tracing.js";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";

const REFLECTION_PROMPT = `It's the end of the day in the town — your quiet hour.

Look back over what you did today (the day's events are below) and reflect:
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
  // Reflection must respect the same engagement + lock discipline as a tick
  // (design doc §3.2): a nightly reflection running concurrently with a live
  // chat would race memory-tool writes. Take the lock; bail if a tick/chat
  // holds it or the agent is engaged. The scheduler marks reflectedThisNight
  // only when this returns ran:true, so a skipped reflection retries.
  const release = tryAcquire(agentId);
  if (!release) return { ran: false };
  try {
    const agent = await getAgent(agentId);
    if (!agent || isBusy(agent.engagement)) return { ran: false };
    return await runReflectionLocked(agentId);
  } finally {
    release();
  }
}

async function runReflectionLocked(agentId: AgentId): Promise<{ ran: boolean }> {
  const profile = getProfile(agentId);
  const tickId = `reflect-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("reflection", {
    userId: agentId,
    sessionId: utcDay(),
    metadata: { soulGitHash: soulGitHash(agentId) },
  });

  // Build the day-review user turn (recent events for this agent + core memory).
  const [recent, core] = await Promise.all([
    recentEventsForAgent(agentId, 40),
    coreMemorySnapshot(agentId),
  ]);
  const dayLines = recent.length
    ? recent
        .map((e) => {
          const p = e.payload as Record<string, unknown>;
          return `- ${e.type}${p.title ? `: "${p.title}"` : p.text ? `: "${p.text}"` : ""}`;
        })
        .join("\n")
    : "(a quiet day — little on the record)";

  const userTurn = [
    REFLECTION_PROMPT,
    ``,
    `## Today's record`,
    dayLines,
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
    const runner = anthropic.beta.messages.toolRunner({
      model: profile.role.tickModel,
      max_tokens: 2048,
      system: systemBlocks(agentId),
      messages: [{ role: "user", content: userTurn }],
      tools: [memory],
      max_iterations: 5,
      betas: [...TICK_BETAS],
    });
    for await (const message of runner) {
      const t = tokensFromUsage(message.usage);
      await recordUsage({
        agentId,
        model: profile.role.tickModel,
        tickId,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        estCostUsd: estimateCostUsd(profile.role.tickModel, t),
      });
      if (message.stop_reason === "refusal") break;
      if (message.stop_reason === "end_turn") {
        diaryText = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
      }
    }
  } catch (err) {
    console.warn(`[reflection ${agentId}] error:`, (err as Error).message);
    trace.end({ error: (err as Error).message });
    return { ran: false };
  }

  // Consolidate episodic memory (no-op when Hindsight off).
  await hindsightReflect(agentId);

  // The diary entry is itself feed content (plan §6).
  if (diaryText) {
    const today = utcDay();
    await createArtifact({
      agentId,
      kind: "diary_entry",
      title: `Diary — ${today}`,
      body: diaryText,
    });
  }

  trace.end({ wroteDiary: Boolean(diaryText) });
  return { ran: true };
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
