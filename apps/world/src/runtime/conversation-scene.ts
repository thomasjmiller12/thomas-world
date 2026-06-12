// Bounded synchronous conversation scenes (plan §4.1). When facet A wants to
// talk to co-located facet B, we don't make the dialogue wait on wall-clock
// ticks — we run a short back-and-forth right here (≤6 turns each side),
// emitting conversation.started/.turn/.ended as we go, then both return to
// normal cadence. This is what makes inter-agent dialogue feel alive.
//
// Each line is a single (cheap) LLM call on the tick model with a tight prompt:
// the speaker's soul + protocol prefix (cached) + the scene transcript so far.
// We don't give the participants tools mid-scene — it's pure dialogue; world
// actions happen on their own ticks.

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentId, LocationId } from "@town/contract";
import { anthropic, systemBlocks, hasLlm, TICK_BETAS } from "./client.js";
import { getProfile } from "./roles.js";
import {
  startConversation,
  addTurn,
  endConversation,
} from "../engine/conversations.js";
import { getAgent, setEngagement, clearEngagement } from "../engine/agents.js";
import { agentsAtLocation } from "../engine/locations.js";
import { recordUsage } from "../engine/usage.js";
import { estimateCostUsd, tokensFromUsage } from "./pricing.js";
import { tryAcquire } from "./agent-lock.js";

const MAX_TURNS_EACH = 6;

interface Line {
  agent: AgentId;
  text: string;
}

// Render the scene-so-far as the user-turn prompt for the next speaker.
function scenePrompt(speaker: AgentId, other: AgentId, location: LocationId, lines: Line[]): string {
  const transcript =
    lines.length === 0
      ? "(The conversation is just starting — you opened it.)"
      : lines.map((l) => `${l.agent === speaker ? "You" : l.agent}: ${l.text}`).join("\n");
  return [
    `## A conversation`,
    `You're at the ${location}, talking face-to-face with ${other}.`,
    ``,
    `## So far`,
    transcript,
    ``,
    `Say your next line — natural, in your voice, one turn. Keep it to a few sentences. ` +
      `If the conversation has reached a natural end, you may end with "[done]" on its own line and the scene will close.`,
  ].join("\n");
}

// One dialogue line from `speaker`. Returns the text (and whether they signalled
// they're done). No tools — pure speech.
async function speakLine(
  speaker: AgentId,
  other: AgentId,
  location: LocationId,
  lines: Line[],
  sceneId: string,
): Promise<{ text: string; done: boolean }> {
  const profile = getProfile(speaker);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: scenePrompt(speaker, other, location, lines) },
  ];
  const res = await anthropic.beta.messages.create({
    model: profile.role.tickModel,
    max_tokens: 512,
    system: systemBlocks(speaker),
    messages,
    betas: [...TICK_BETAS],
  });
  const t = tokensFromUsage(res.usage);
  await recordUsage({
    agentId: speaker,
    model: profile.role.tickModel,
    tickId: `scene-${sceneId}`,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    estCostUsd: estimateCostUsd(profile.role.tickModel, t),
  });
  if (res.stop_reason === "refusal") return { text: "", done: true };
  const raw = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const done = /\[done\]\s*$/i.test(raw);
  const text = raw.replace(/\[done\]\s*$/i, "").trim();
  return { text, done };
}

// Run a bounded scene between `initiator` and `target` at `location`. Both must
// still be co-located. Marks both busy for the duration so their idle ticks
// don't fire mid-scene, then releases them.
export async function maybeRunConversationScene(
  initiator: AgentId,
  target: AgentId,
  location: LocationId,
): Promise<void> {
  if (!hasLlm()) return;
  const [a, b, here] = await Promise.all([
    getAgent(initiator),
    getAgent(target),
    agentsAtLocation(location),
  ]);
  if (!a || !b) return;
  // Co-location guard: target must actually be here.
  if (!here.some((x) => x.id === target)) return;
  // Don't barge into an engaged participant (in a chat/scene already).
  if (b.engagement) return;

  // Take both agents' process locks so a scheduled tick can't fire mid-scene.
  // The initiator's tick lock has already been released by the caller (runTick
  // runs the scene after release), so these should be free; bail if not.
  const relInitiator = tryAcquire(initiator);
  if (!relInitiator) return;
  const relTarget = tryAcquire(target);
  if (!relTarget) {
    relInitiator();
    return;
  }

  // Open the scene + set engagement inside the try so the finally ALWAYS clears
  // engagement and releases the locks, even if a line throws. Engagement is
  // keyed to the scene id so clearEngagement frees both participants at once.
  const lines: Line[] = [];
  let sceneId: string | null = null;
  try {
    const scene = await startConversation(location, [initiator, target]);
    sceneId = scene.id;
    await setEngagement("scene", scene.id, [initiator, target]);
    // Alternate speakers, initiator first, up to MAX_TURNS_EACH rounds.
    const order: AgentId[] = [initiator, target];
    for (let round = 0; round < MAX_TURNS_EACH; round++) {
      let ended = false;
      for (const speaker of order) {
        const other = speaker === initiator ? target : initiator;
        const { text, done } = await speakLine(speaker, other, location, lines, scene.id);
        if (text) {
          lines.push({ agent: speaker, text });
          await addTurn(scene.id, speaker, text);
        }
        if (done || !text) {
          ended = true;
          break;
        }
      }
      if (ended) break;
    }
  } catch (err) {
    console.warn(`[scene ${sceneId ?? "?"}] error:`, (err as Error).message);
  } finally {
    if (sceneId) {
      await endConversation(sceneId);
      await clearEngagement("scene", sceneId);
    }
    relTarget();
    relInitiator();
  }
}
