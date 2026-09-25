// Nightly reflection ("sleep") — now a TURN ON THE CONTINUOUS THREAD (M3). The
// agent reviews its day (which is already in its thread — no day-record needs
// assembling), promotes stable patterns into core memory (via the memory tool),
// retains public evidence and writes a short diary entry (itself feed
// content + the recovery seed). Runs once per agent overnight.
//
// The actual LLM turn goes through runTurn() (turn.js) so reflection happens
// WITHIN the agent's ongoing conversation. Native compaction is driven by
// context size, not midnight. Bounded read tools let the agent verify old
// claims; only its private memory/current pursuits may be edited in this turn.
//
// Called by the loop's executor for a {kind:'reflection'} input, so the per-agent
// queue already serializes it — no separate lock/engagement guard needed.

import type { AgentId } from "@town/contract";
import { hasLlm } from "./llm/provider.js";
import { getProfile, soulGitHash } from "./roles.js";
import { coreMemorySnapshot } from "../engine/memory.js";
import { createArtifact, recentArtifactsBy } from "../engine/artifacts.js";
import { remember, recall } from "./hindsight.js";
import { startTrace } from "./tracing.js";
import { runTurn } from "./turn.js";
import { recordTurnFailure } from "./failure-handler.js";
import { randomUUID } from "node:crypto";
import { buildReflectionTools } from "./tools.js";
import { renderPursuits } from "./pursuits.js";
import { getAgent } from "../engine/agents.js";
import { recentEventsForAgent, recentPublicWorkForAgent } from "../engine/events.js";
import { townDate } from "./clock.js";

const REFLECTION_PROMPT = `It's the end of the day in the town — your quiet hour.

Look back over your day (it's all in your memory above) and reflect:
- What actually happened, in your own read of it?
- Did anything shift in how you see things, what you're working on, or your
  relationships with the other facets?
- Is there a stable pattern worth promoting into your core memory (the
  always-loaded files) — or something stale in there to prune? Use the memory
  tool to keep core memory short, current, and true. Don't journal into it;
  core memory is for durable facts — about who you are, what you're focused
  on, and the people you've come to know (a returning visitor's name, what
  they care about, where things stand with them belongs here as much as
  anything about yourself) — not a play-by-play of the day itself.

Reconcile your current pursuits with the actual world before carrying them
forward. You can read artifacts, their live state, repository files, and your
capability decisions. A remembered blocker is a claim to check, not a standing
order. Use update_pursuits when a next step, dependency, or status changes.
Keep at most two active interests and a concrete entry point for tomorrow.
Park a genuinely blocked idea with its dependency; preserve dormant ideas in
private notes instead of making all of them daily obligations. Mark work done
only when there is a real result. Keep tastes and relationships intact.
Reading, planning, a new activity label, and this diary are not delivered work.
It is fine to have a quiet day; don't invent changes to make the entry exciting.

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
  const observedAt = new Date();
  const today = townDate(observedAt);
  const profile = getProfile(agentId);
  const tickId = `reflect-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("reflection", {
    userId: agentId,
    sessionId: today,
    metadata: {
      soulGitHash: soulGitHash(agentId),
      provider: profile.role.tickModel.provider,
      model: profile.role.tickModel.model,
      endpoint: "turn",
      thread_provider: profile.role.tickModel.provider,
    },
  });

  // The reflection input. The day itself is ALREADY in the thread (M3) — we only
  // surface current core memory so the agent can curate it, then prompt the
  // reflection + diary. This is appended to the continuous thread by runTurn.
  const [core, agent, recent, pursuits] = await Promise.all([
    coreMemorySnapshot(agentId), getAgent(agentId), recentEventsForAgent(agentId, 30),
    renderPursuits(agentId, observedAt),
  ]);
  const since = observedAt.getTime() - 24 * 60 * 60 * 1000;
  const evidence = recent.filter((event) => Date.parse(event.ts) >= since);
  // Public, source-linked facts only. Never automatically retrieve a private
  // visitor digest into an autonomous reflection. Same-day retry upserts the
  // same document, while diary idempotency continues to guard the model turn.
  const publicEvidence = publicMemoryEvidence(await recentPublicWorkForAgent(agentId, new Date(since)));
  if (publicEvidence) {
    await remember(agentId, publicEvidence, "town_public", {
      documentId: `town-public:${agentId}:${today}`,
      observedAt: observedAt.toISOString(),
      metadata: { source: "world_events", town_date: today },
    });
  }
  const past = await recall(agentId, `Public work relevant to these current pursuits: ${pursuits.slice(0, 1200)}`, 600, { tags: ["town_public"] });
  const inputText = [
    REFLECTION_PROMPT,
    `## Current world evidence (bounded sample from the last 24 hours)`,
    `Location: ${agent?.locationId ?? "unknown"}. Activity: ${agent?.activity ?? "unspecified"}.`,
    ...evidence.map((event) => `${event.ts} ${event.type}: ${JSON.stringify(event.payload).slice(0, 600)}`),
    ...(evidence.length ? [] : ["No recent events in this sample. Do not invent any."]),
    ``,
    `## Your core memory right now`,
    core,
    ``,
    `## Your current pursuits and linked world state`,
    pursuits,
    ``,
    `## Retrieved public evidence (historical; check current state before acting)`,
    past.ok ? past.text : "Episodic retrieval is unavailable. Use canonical world records; do not invent a recollection.",
  ].join("\n");

  const tools = buildReflectionTools({ agentId, location: agent?.locationId ?? "town" });

  let diaryText = "";
  try {
    // Reflection runs as a turn on the continuous thread: introspective, memory
    // edits and bounded verification reads, the diary is the final text. advanceCursorTo omitted → the
    // perception cursor is preserved (reflection perceives nothing new).
    const outcome = await runTurn({
      agentId,
      purpose: "reflection",
      observedAt,
      model: profile.role.tickModel,
      maxTokens: 2048,
      inputText,
      tools,
      tickId,
      trace,
    });
    if (!outcome.refused) diaryText = outcome.finalText;
  } catch (err) {
    // Reflection runs on the same continuous thread, so a poisoned-thread error
    // shows up here too — often FIRST, since reflection keeps firing overnight
    // while ticks are gated by waking hours.
    await recordTurnFailure(agentId, err, "reflection");
    trace.end({ error: (err as Error).message });
    return { ran: false };
  }

  // The diary doubles as the idempotency marker. No second provider synthesis
  // call after it: Hindsight reflect returns an answer, not consolidation.
  if (diaryText) {
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

const PUBLIC_WORK = new Set(["artifact.created", "artifact.updated", "artifact.state_changed", "capability.resolved"]);
export function publicMemoryEvidence(events: Array<{ id?: string; ts: string; type: string; visibility?: string; payload: unknown }>): string {
  const lines = events.filter((event) => {
    const payload = event.payload as { kind?: string };
    return event.visibility === "public" && PUBLIC_WORK.has(event.type) &&
      !["diary_entry", "daily_digest", "bulletin"].includes(payload.kind ?? "");
  }).slice(-12).map((event) => {
    let payload = JSON.stringify(event.payload).slice(0, 500);
    if (event.type === "capability.resolved") {
      const decision = event.payload as {
        requestId: string; agent: string; status: string; summary: string; note?: string;
      };
      // A long original request must not hide the actual decision or its
      // qualification (for example, Python works but persistent hosting does not).
      // Resolution notes are already capped at 500 chars by the write path.
      payload = JSON.stringify({
        requestId: decision.requestId,
        agent: decision.agent,
        status: decision.status,
        ...(decision.note ? { note: decision.note.slice(0, 500) } : {}),
        summary: decision.summary.slice(0, 160),
      });
    }
    return `Source world_event:${event.id ?? "unknown"} at ${event.ts}: ${event.type} ${payload}`;
  });
  // Keep the newest complete source records. Cutting the joined string could
  // otherwise remove a resolution qualification from the last retained event.
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.reverse()) {
    const length = line.length + (kept.length ? 1 : 0);
    if (chars + length > 6000) break;
    kept.unshift(line);
    chars += length;
  }
  return kept.join("\n");
}
