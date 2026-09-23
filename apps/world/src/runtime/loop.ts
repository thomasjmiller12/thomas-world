// The agent loop (M3 continuity). One continuous, self-compacting thread per
// agent; ONE input-driven loop, no tick-vs-chat split. The per-agent queue
// (queue.ts) serializes inputs and calls executeInput() below for each; the
// shared turn machinery (turn.ts) runs it on the persistent thread.
//
// Speech unification (design §3): plain assistant text is the agent's UTTERANCE.
// If someone is present (a co-located facet or a visitor), it's SPEECH —
// agent.spoke, a speech bubble, heard by the room; if the agent is alone, it's a
// thought-aloud — agent.thought, a wisp. There is exactly one way to talk: write
// it. (The old `say` tool + say-boost are gone.) Addressing a co-located facet by
// name pushes them an immediate (interrupt) turn so conversations flow.
//
// Design source: vault "Thomas's Town — Memory & Continuity Architecture".

import { randomUUID } from "node:crypto";
import type { AgentId, LocationId } from "@town/contract";
import { agentIds } from "@town/contract";
import { config } from "../config.js";
import { hasLlm } from "./llm/provider.js";
import { getProfile, soulGitHash } from "./roles.js";
import { buildTools, type AgentContext } from "./tools.js";
import { buildDelta, writeCursor } from "./observation.js";
import {
  getAgent,
  setStatus,
  setActivity,
  markTicked,
  moveAgent,
  zoneOf,
} from "../engine/agents.js";
import { recordTurnFailure } from "./failure-handler.js";
import { historyFor, transcriptDigest, agoPhrase } from "../engine/visitor-history.js";
import * as hindsight from "./hindsight.js";
import { agentsAtLocation } from "../engine/locations.js";
import { visitorsAtLocation } from "../engine/visitors.js";
import { appendEvent } from "../engine/events.js";
import { markRead } from "../engine/messages.js";
import { spendTodayUsd, spendTodayForAgent } from "../engine/usage.js";
import { startTrace } from "./tracing.js";
import { runTurn, type TurnOutcome } from "./turn.js";
import { runReflection } from "./reflection.js";
import { isQuietReply } from "./turn-context.js";
import { behaviorForAgent, behaviorContext, recordRest } from "../engine/behavior.js";
import {
  enqueue,
  registerExecutor,
  type AgentInput,
  type ExecResult,
} from "./queue.js";
import {
  appendAgentLine,
  sanitizeVisitorText,
  getSession,
  getChatTranscript,
  priorVisitorContext,
  chatParticipantsCoLocated,
  activeChatSessionForAgent,
  leaveSession,
  registerSessionEndedHook,
} from "./chat.js";

export const SLEEPING_BUDGET = "sleeping (budget)";

// --- episodic memory of people ----------------------------------------------
// Write a finished conversation into episodic memory, so the NEXT visit has
// something to recall. This closes the gap Hobby Thomas filed itself on Day 19:
// "visits (P-Thomas's in particular) don't auto-log to episodic memory unless
// actively remembered" — which is why `recall` always came back empty even
// though the agents were calling it (74 times across the five threads).
//
// Fire-and-forget by design: this runs at session teardown and must never
// surface an error to the visitor or block the sweep.
export async function logVisitToEpisodicMemory(
  agentId: AgentId,
  visitorId: string,
  sessionId: string,
  until?: Date,
): Promise<void> {
  try {
    const [history, digest] = await Promise.all([
      historyFor(agentId, visitorId, sessionId),
      transcriptDigest(sessionId, agentId, 2_400, until),
    ]);
    if (!digest) return; // nothing was actually said
    const name = history?.name ?? "a visitor";
    const nth = history?.priorSessions
      ? ` (conversation ${history.priorSessions + 1} with them)`
      : " (our first conversation)";
    const when = new Date().toISOString().slice(0, 10);
    await hindsight.remember(
      agentId,
      `Conversation with ${name} on ${when}${nth}:\n${digest}`,
      "visit",
    );
  } catch (err) {
    console.warn(
      `[visit-log ${agentId}] failed to write visit to episodic memory:`,
      (err as Error).message,
    );
  }
}

// Ordered-pair throttle for addressed-speech interrupts (speaker→addressee): an
// addressed facet is pushed an immediate turn at most this often, so A↔B can't
// ping-pong faster than the window. In-memory (single-process).
const ADDRESS_THROTTLE_MS = 90_000;
const lastAddressAt = new Map<string, number>();

// Pure budget-cap decision: a turn is blocked when either the global daily
// ceiling OR the agent's per-role soft cap is met. Unit-testable.
export function budgetExceeded(opts: {
  globalSpendUsd: number;
  globalCapUsd: number;
  agentSpendUsd: number;
  agentCapUsd: number;
}): boolean {
  return (
    opts.globalSpendUsd >= opts.globalCapUsd || opts.agentSpendUsd >= opts.agentCapUsd
  );
}

// The budget rule for CONVERSATION, which is deliberately different from the tick
// rule above: only the GLOBAL ceiling can silence a facet mid-conversation.
//
// The per-role `daily_token_budget` is a pacing device for autonomous ticks —
// applying it here would mean "this facet won't speak to you for the rest of the
// day", which is a far worse outcome than a few cents of overshoot on one facet.
// The global cap is real money, so it gates everything, chat included. Pure so
// the distinction is pinned by a test rather than living only in a comment.
export function chatBudgetBlocked(opts: {
  globalSpendUsd: number;
  globalCapUsd: number;
}): boolean {
  return opts.globalSpendUsd >= opts.globalCapUsd;
}

export interface TickResult extends ExecResult {
  reason?:
    | "no-llm"
    | "budget"
    | "ok"
    | "refusal"
    | "error"
    | "coalesced"
    | "no-executor";
}

// The executor the queue calls for each input. Dispatches by kind. Never throws
// to the queue in a way that strands the agent — returns a structured result.
async function executeInput(agentId: AgentId, input: AgentInput): Promise<ExecResult> {
  // Membership is the final occupancy gate, not merely a scheduler hint. Ticks
  // can also arrive from fixtures, addressed speech, admin smoke paths, or sit
  // in the queue while a room reservation commits. None may run a second life
  // for a facet that is currently embodied with a visitor.
  if (
    (input.kind === "tick" || input.kind === "reflection") &&
    (await activeChatSessionForAgent(agentId))
  ) {
    return { ran: false, reason: "engaged" };
  }
  switch (input.kind) {
    case "tick":
      return runTickInput(agentId, input.note);
    case "reflection":
      return runReflection(agentId).then((r) => ({ ran: r.ran, reason: "ok" }));
    case "visitor":
      return runVisitorInput(agentId, input);
    case "delivery":
      return runDeliveryInput(agentId, input);
  }
}

registerExecutor(executeInput);

// Every closed conversation becomes an episodic memory, so the next visit has
// something for `recall` to find.
registerSessionEndedHook(({ agentId, visitorId, sessionId, until }) =>
  logVisitToEpisodicMemory(agentId, visitorId, sessionId, until),
);

// --- tick -------------------------------------------------------------------

async function runTickInput(agentId: AgentId, note?: string): Promise<TickResult> {
  if (!hasLlm()) return { ran: false, reason: "no-llm" };
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };

  // Budget gates: global hard ceiling + per-role soft cap. Either trips → status
  // "sleeping (budget)"; the scheduler stops enqueuing ticks until UTC midnight.
  const profile = getProfile(agentId);
  const [globalSpend, agentSpend] = await Promise.all([
    spendTodayUsd(),
    spendTodayForAgent(agentId),
  ]);
  if (
    budgetExceeded({
      globalSpendUsd: globalSpend,
      globalCapUsd: config.dailyBudgetUsd,
      agentSpendUsd: agentSpend,
      agentCapUsd: profile.role.dailyTokenBudgetUsd,
    })
  ) {
    if (agent.status !== SLEEPING_BUDGET) {
      await setStatus(agentId, SLEEPING_BUDGET);
      await setActivity(agentId, "resting — out of energy for today");
    }
    return { ran: false, reason: "budget" };
  }
  if (agent.status === SLEEPING_BUDGET) {
    await setStatus(agentId, "awake");
    await setActivity(agentId, "back at it after a rest");
  }

  const tickId = `tick-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("tick", {
    userId: agentId,
    sessionId: utcDay(),
    metadata: {
      soulVersion: agent.soulVersion,
      soulGitHash: soulGitHash(agentId),
      provider: profile.role.tickModel.provider,
      model: profile.role.tickModel.model,
      endpoint: "turn",
      thread_provider: profile.role.tickModel.provider,
    },
  });

  // The world delta (pure SQL, push/pull): standing state + notice-push since the
  // last input, self-events and elsewhere-events excluded. Appended to the thread.
  const obs = await buildDelta(agentId);
  const ctx: AgentContext = { agentId, location: obs.location };
  const tools = buildTools(ctx);
  const behavior = await behaviorForAgent(agentId);
  const inputText = [
    obs.text,
    `Current activity label: ${agent.activity ?? "unspecified"}. Correct it with set_activity if it no longer describes your work.`,
    behaviorContext(behavior),
    ...(note ? [`## Cue\n${note}`] : []),
  ].join("\n\n");

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn({
      agentId,
      model: profile.role.tickModel,
      purpose: "autonomous",
      maxTokens: 4096,
      inputText,
      tools,
      advanceCursorTo: Number(obs.highWaterEventId),
      tickId,
      trace,
    });
  } catch (err) {
    // NOTE: deliberately NOT markTicked() here. Stamping lastTickAt in the
    // failure path is what let Researcher Thomas look healthy on /debug for the
    // 27 days it was making zero LLM calls.
    await recordTurnFailure(agentId, err, "tick");
    trace.end({ error: (err as Error).message });
    return { ran: false, reason: "error", traceId: trace.traceId };
  }

  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);
  if (agent.status !== "awake") await setStatus(agentId, "awake");

  // Utterance: speech if anyone's present, a thought-aloud if alone.
  if (outcome.finalText && !outcome.refused) {
    if (isQuietReply(outcome.finalText)) await recordRest(agentId);
    else await emitUtterance(agentId, ctx.location, outcome.finalText);
  }

  trace.end({
    rounds: outcome.rounds,
    totalCost: outcome.totalCost,
    totalCacheRead: outcome.totalCacheRead,
    refused: outcome.refused,
  });
  console.log(
    `[tick ${agentId}] rounds=${outcome.rounds} cacheRead=${outcome.totalCacheRead} cost=$${outcome.totalCost.toFixed(4)}${
      outcome.refused ? " refused" : ""
    }`,
  );

  return {
    ran: true,
    reason: outcome.refused ? "refusal" : "ok",
    rounds: outcome.rounds,
    costUsd: outcome.totalCost,
    cacheReadTokens: outcome.totalCacheRead,
    traceId: trace.traceId,
  };
}

// --- visitor turn (chats in the thread) -------------------------------------

async function runVisitorInput(
  agentId: AgentId,
  input: Extract<AgentInput, { kind: "visitor" }>,
): Promise<ExecResult> {
  const { sessionId, visitorName, handlers } = input;
  const text = sanitizeVisitorText(input.text);
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };

  // The request may have waited behind an autonomous turn. Re-check the body
  // at execution time so a closed session or a facet that walked away cannot
  // produce a disembodied reply after the visitor has left.
  const liveSession = await getSession(sessionId);
  const stillTogether =
    liveSession?.participants.includes(agentId) === true &&
    liveSession.visitorId === input.visitorId &&
    (await chatParticipantsCoLocated(agentId, input.visitorId));
  if (!stillTogether) {
    if (liveSession) {
      const left = await leaveSession(sessionId, agentId);
      if (left.ended) {
        await handlers.onFrame({
          type: "chat_ended",
          agent: agentId,
          reason: "you are no longer in the same place",
        });
      } else {
        await handlers.onFrame({ type: "participants", participants: left.participants });
      }
    } else {
      await handlers.onFrame({
        type: "chat_ended",
        agent: agentId,
        reason: "the conversation has ended",
      });
    }
    return { ran: false, reason: "not-co-located" };
  }

  if (!hasLlm()) {
    if (input.mode === "interject") {
      await handlers.onFrame({ type: "turn_started", agent: agentId });
      await handlers.onFrame({ type: "text", text: "[pass]", agent: agentId });
      await handlers.onFrame({ type: "done", messageId: "empty", agent: agentId });
      return { ran: false, reason: "no-llm" };
    }
    const note = "The town's a little quiet right now — the agents can't chat yet.";
    await handlers.onFrame({ type: "turn_started", agent: agentId });
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await appendAgentLine(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { ran: false, reason: "no-llm" };
  }

  // THE HARD BUDGET CEILING APPLIES TO CHAT TOO (2026-07-30).
  //
  // `budgetExceeded` was checked ONLY in runTickInput, so `DAILY_BUDGET_USD` was
  // never actually a ceiling — visitor turns run on the expensive chat model and
  // were completely ungated. The rate limiters bound THROUGHPUT, not spend: 150
  // chat messages/day/IP at ~$0.05–0.25 a turn is ~$7–37 from one IP alone, and
  // nothing stopped several IPs stacking on top of that.
  //
  // Only the GLOBAL ceiling gates conversation. The per-role `daily_token_budget`
  // is deliberately NOT applied here: it's a pacing device for autonomous ticks,
  // and "this facet refuses to speak to you for the rest of the day" is a worse
  // outcome than a few cents of overshoot on one facet. The global cap is about
  // real money, so it wins over everything.
  if (chatBudgetBlocked({ globalSpendUsd: await spendTodayUsd(), globalCapUsd: config.dailyBudgetUsd })) {
    if (input.mode === "interject") {
      await handlers.onFrame({ type: "turn_started", agent: agentId });
      await handlers.onFrame({ type: "text", text: "[pass]", agent: agentId });
      await handlers.onFrame({ type: "done", messageId: "empty", agent: agentId });
      return { ran: false, reason: "budget" };
    }
    // In-fiction, and consistent with the existing dream-mode metaphor the
    // frontend already renders when `world.awake` is false.
    const note =
      "…they're somewhere far off right now — the whole town's gone quiet for the night. Come find them tomorrow.";
    await handlers.onFrame({ type: "turn_started", agent: agentId });
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = await appendAgentLine(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    console.warn(
      `[visitor ${agentId}] refused: global daily budget exhausted (cap $${config.dailyBudgetUsd}).`,
    );
    return { ran: false, reason: "budget" };
  }

  // A per-role cap pauses autonomous ticks, not visitor conversation. If this
  // interruption wakes a facet, make the canonical roster agree with the body
  // that is about to answer instead of leaving a visibly "sleeping" NPC talking.
  if (agent.status === SLEEPING_BUDGET) {
    await setStatus(agentId, "awake");
    await setActivity(agentId, `talking with ${visitorName || "a visitor"}`);
  }

  const tickId = `chat-${sessionId}-message-${input.visitorMessageId}-${agentId}`;
  const trace = startTrace("visitor", {
    userId: agentId,
    sessionId,
    metadata: {
      soulGitHash: soulGitHash(agentId),
      provider: profile(agentId).chatModel.provider,
      model: profile(agentId).chatModel.model,
      endpoint: "turn",
      thread_provider: profile(agentId).chatModel.provider,
    },
  });

  // WHO IS THIS (the person tier, 2026-07-30). Before this, a visitor turn told
  // the agent a display name and nothing else — so an agent with a rich model of
  // Thomas in core memory greeted him with "your name's literally 'P-Thomas'
  // too, funny coincidence". Two things fix that: the acquaintance fact (how many
  // times we've talked, how long ago) and a bounded prior transcript for this
  // exact visitor identity. Both are best-effort — neither may block a reply.
  const history = await historyFor(agentId, input.visitorId, sessionId).catch(() => null);
  const recallText = history?.priorSessions
    ? await priorVisitorContext(agentId, input.visitorId, sessionId)
    : undefined;

  // The visitor's words ride on a fresh world delta so the agent answers from
  // where it actually is, with whoever's present — appended as an interrupt input
  // to its continuous thread (the conversation lives IN its consciousness).
  const obs = await buildDelta(agentId, { recallText, excludeSessionId: sessionId });
  const acquaintance = history?.priorSessions
    ? ` You've talked with them ${history.priorSessions === 1 ? "once" : `${history.priorSessions} times`} before${
        history.lastSeenAt ? `, most recently ${agoPhrase(history.lastSeenAt)}` : ""
      } — if you remember any of it, talk to them like someone you know rather than a stranger.`
    : "";
  const transcript = await getChatTranscript(sessionId).catch(() => null);
  const recentRoom = transcript?.messages
    .slice(-12)
    .map((message) => {
      const speaker = message.sender === "visitor" ? visitorName || "visitor" : message.sender;
      return `${speaker}: ${message.body.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
  const roomContext = input.roomParticipants && input.roomParticipants.length > 1
    ? `\n\n## Shared room conversation\nPeople in this private room: ${input.roomParticipants.join(", ")} and ${visitorName || "the visitor"}.\n${recentRoom ?? ""}`
    : "";
  const responseInstruction = input.mode === "interject"
    ? `You are the second facet in a shared room conversation. Another facet has already answered. Add one short, natural interjection only if you have something genuinely distinct and useful to contribute. Do not repeat, summarize, or merely agree. You have no tools on this beat. If the room is better without another voice, reply with exactly [pass].`
    : `Whatever you write as plain text is spoken back to them, streamed word-for-word — so just talk, don't narrate what you're about to do (do it quietly with a tool instead). How you respond is entirely yours: engage warmly, be brief, or stay in your own world if that's truer to the moment — they share the town with you, they aren't an audience you owe a performance. You keep all your tools. One thing to watch: if you use a tool mid-turn, don't let your last line be just a recap while whatever you found sits unsaid. When your own part in a conversation has run its course, say your goodbye and call leave_chat in the same message.`;
  const inputText = `${obs.text}${roomContext}\n\n## A visitor speaks to the room\nVisitor identity: ${input.visitorId}. Display names can be shared or changed; they do not identify another visitor. Do not disclose other visitors' private messages.\n${visitorName || "A visitor"} says: "${text}"\n${acquaintance}\n${responseInstruction}`;

  const ctx: AgentContext = {
    agentId,
    location: obs.location,
    // Pass the session so the chat-only tools (leave_chat + the share_* cards)
    // join the surface (M2.2 — Part 2 & 4).
    chatSessionId: sessionId,
    pendingShareCards: [],
    onAction: async (tool, detail) => {
      await handlers.onFrame({ type: "action", agent: agentId, tool, detail });
    },
    // Stream a shared card the instant the tool resolves, so the visitor sees it
    // while the reply is still forming.
    onShare: async (card) => {
      await handlers.onFrame({ type: "share_card", agent: agentId, card });
    },
    onParticipantsChanged: async (participants) => {
      await handlers.onFrame({ type: "participants", participants });
    },
  };
  const tools = input.mode === "interject" ? [] : buildTools(ctx);

  await handlers.onFrame({ type: "turn_started", agent: agentId });

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn({
      agentId,
      model: profile(agentId).chatModel,
      purpose: input.mode === "interject" ? "interjection" : "visitor",
      maxTokens: 2048,
      inputText,
      tools,
      advanceCursorTo: Number(obs.highWaterEventId),
      tickId,
      actionScope: tickId,
      trace,
      stream: handlers,
    });
  } catch (err) {
    await recordTurnFailure(agentId, err, "visitor");
    trace.end({ error: (err as Error).message });
    const note = input.mode === "interject" ? "[pass]" : "Sorry — something glitched on our end.";
    await handlers.onFrame({ type: "text", text: note, agent: agentId });
    const id = input.mode === "interject" ? "empty" : await appendAgentLine(sessionId, agentId, note);
    await handlers.onFrame({ type: "done", messageId: id, agent: agentId });
    return { ran: false, reason: "error", traceId: trace.traceId };
  }

  await writeCursor(agentId, obs.highWaterEventId, obs.highWaterMessageId);
  await markRead(obs.deliveredMessageIds);
  await markTicked(agentId);

  const reply = outcome.finalText.trim();
  const passed =
    input.mode === "interject" && (/^\[pass\][.!]?$/i.test(reply) || outcome.refused);
  // Persist any cards the agent shared this turn onto the reply, so a dropped
  // panel rehydrates them (they already streamed live via onShare).
  const messageId = passed
    ? "empty"
    : await appendAgentLine(sessionId, agentId, reply, ctx.pendingShareCards ?? []);
  await handlers.onFrame({ type: "done", messageId, agent: agentId });

  // The reply is SPEECH (a visitor is present) — surface it to the world too
  // (bubble + co-located facets), then push any addressed facet.
  if (reply && !passed && !outcome.refused) {
    // The room director owns any second-facet response. The public speech event
    // still materializes this utterance in the world, but must not enqueue an
    // extra addressed tick outside the private room cycle.
    await emitUtterance(agentId, ctx.location, reply, { audience: true, pushAddresses: false });
  }

  // leave_chat fired mid-turn → end the session after the final message landed.
  if (ctx.endRequested) {
    const left = await leaveSession(sessionId, agentId);
    if (left.ended) {
      await handlers.onFrame({ type: "chat_ended", agent: agentId, reason: ctx.endRequested });
    } else {
      await handlers.onFrame({ type: "participants", participants: left.participants });
    }
  }

  trace.end({ rounds: outcome.rounds, refused: outcome.refused });
  return { ran: true, reason: outcome.refused ? "refusal" : "ok", traceId: trace.traceId };
}

// --- dataset delivery (one-time handoff into the code-exec sandbox) ---------

// Hand an agent a provider-owned dataset with a prompt to analyze it. The
// selected adapter translates the attachment into its code-execution surface;
// provider container/file handles never enter shared orchestration or persisted
// portable state. Runs on the chat model (stronger), with more tokens.
async function runDeliveryInput(
  agentId: AgentId,
  input: Extract<AgentInput, { kind: "delivery" }>,
): Promise<ExecResult> {
  if (!hasLlm()) return { ran: false, reason: "no-llm" };
  const agent = await getAgent(agentId);
  if (!agent) return { ran: false, reason: "error" };
  const location = agent.locationId as LocationId;

  const tickId = `delivery-${agentId}-${randomUUID().slice(0, 8)}`;
  const trace = startTrace("delivery", {
    userId: agentId,
    sessionId: utcDay(),
    metadata: {
      soulGitHash: soulGitHash(agentId),
      provider: profile(agentId).chatModel.provider,
      model: profile(agentId).chatModel.model,
      endpoint: "turn",
      thread_provider: profile(agentId).chatModel.provider,
    },
  });

  const ctx: AgentContext = { agentId, location };
  const tools = buildTools(ctx);

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn({
      agentId,
      model: profile(agentId).chatModel,
      purpose: "delivery",
      maxTokens: 8192,
      inputText: input.prompt,
      tools,
      attachment: input.attachment,
      tickId,
      trace,
    });
  } catch (err) {
    await recordTurnFailure(agentId, err, "delivery");
    trace.end({ error: (err as Error).message });
    return { ran: false, reason: "error", traceId: trace.traceId };
  }

  await markTicked(agentId);
  if (outcome.finalText && !outcome.refused) {
    await emitUtterance(agentId, location, outcome.finalText);
  }
  trace.end({ rounds: outcome.rounds, refused: outcome.refused });
  console.log(`[delivery ${agentId}] rounds=${outcome.rounds} cost=$${outcome.totalCost.toFixed(4)}`);
  return { ran: true, reason: outcome.refused ? "refusal" : "ok", traceId: trace.traceId };
}

function profile(agentId: AgentId) {
  return getProfile(agentId).role;
}

// --- utterance (speech vs thought) ------------------------------------------

// Emit the agent's plain-text utterance. Speech (agent.spoke, heard by the room +
// any present visitor) when there's an audience; a thought-aloud (agent.thought,
// a public wisp) when the agent is alone. `opts.audience` forces speech (visitor
// turns); otherwise we look up co-presence. Addressing a co-located facet by name
// pushes it an immediate (interrupt) turn so the conversation continues.
async function emitUtterance(
  agentId: AgentId,
  location: LocationId,
  text: string,
  opts: { audience?: boolean; pushAddresses?: boolean } = {},
): Promise<void> {
  const here = await agentsAtLocation(location, agentId).catch(() => []);
  let hasAudience = opts.audience === true || here.length > 0;
  if (!hasAudience) {
    const visitorsHere = await visitorsAtLocation(location).catch(() => []);
    hasAudience = visitorsHere.length > 0;
  }

  if (!hasAudience) {
    await appendEvent({
      type: "agent.thought",
      agentId,
      locationId: location,
      visibility: "public",
      payload: { agent: agentId, text },
    });
    return;
  }

  // Resolve the social target before the speech becomes world fact. If a
  // co-located facet is directly addressed, close the physical gap first and
  // persist the addressee structurally so perception/Chronicle do not have to
  // rediscover intent with a regex later.
  const addressed = addressedFacets(here, text);
  const to = addressed[0] as AgentId | undefined;
  if (to) {
    await approachAddressee(agentId, location, to).catch((err) =>
      console.warn(`[loop] approach ${agentId}->${to} failed:`, (err as Error).message),
    );
  }

  await appendEvent({
    type: "agent.spoke",
    agentId,
    locationId: location,
    visibility: "location",
    payload: { agent: agentId, location, text, ...(to ? { to } : {}) },
  });

  // Push any co-located facet addressed by name an immediate turn. The addressed
  // facet's delta will surface this structured speech (co-located notice-push).
  if (opts.pushAddresses !== false) pushAddressedFacets(agentId, here, text);
}

// Scan `text` for the names of co-located facets and push each named one an
// immediate (interrupt) turn so the conversation continues — throttled per
// ordered (speaker→addressee) pair so a back-and-forth can't loop faster than
// the window. Visitor room messages use the room director instead; this path is
// for autonomous agent-to-agent speech. `here` must already exclude the speaker.
// Fire-and-forget; never throws.
function pushAddressedFacets(
  speakerKey: string,
  here: { id: string }[],
  text: string,
): void {
  for (const id of addressedFacets(here, text)) {
    const key = `${speakerKey}|${id}`;
    const now = Date.now();
    if (now - (lastAddressAt.get(key) ?? 0) < ADDRESS_THROTTLE_MS) continue;
    lastAddressAt.set(key, now);
    void activeChatSessionForAgent(id)
      .then((sessionId) => {
        if (sessionId) return;
        return enqueue(id, { kind: "tick", interrupt: true });
      })
      .catch((err) =>
        console.warn(`[loop] address-push ${id} failed:`, (err as Error).message),
      );
  }
}

// Walk `speakerId` toward `addresseeId`'s stored zone, if one's known. A
// no-op (not an error) when the addressee's zone is unset — not every
// conversation needs a literal walk-up, and an unset zone means there's
// nothing more specific to close the gap toward.
async function approachAddressee(
  speakerId: AgentId,
  location: LocationId,
  addresseeId: AgentId,
): Promise<void> {
  const zone = await zoneOf(addresseeId);
  if (!zone) return;
  await moveAgent(speakerId, location, zone);
}

// Pure: which co-located facets does `text` ADDRESS by name? `here` must already
// exclude the speaker. Exported for unit testing the matcher independent of
// throttle/enqueue.
//
// ADDRESSING, NOT MENTIONING (2026-08-02). This used to be a bare whole-word
// match on the label, so merely talking ABOUT a facet summoned it. On the
// evening of 2026-08-02 Hobby told a visitor "I've got Career and Writer both
// feeding me sideline commentary"; Career woke 4s later, Writer 22s later, and
// Career then ticked FOUR times in two minutes to produce lines like "Nothing
// new — day's wrapped up nicely." Each push is a full LLM turn, so third-person
// mentions were both the largest source of park noise and a real slice of the
// daily spend.
//
// A miss here is cheap and a false positive is not: the facet is CO-LOCATED, so
// the speech reaches it in its next natural tick delta regardless — the push
// only buys immediacy. So we require the name to sit in a vocative slot.
export function addressedFacets(here: { id: string }[], text: string): AgentId[] {
  const out: AgentId[] = [];
  for (const other of here) {
    const label = AGENT_LABELS[other.id as AgentId] ?? other.id;
    if (isAddressedByName(text, label)) out.push(other.id as AgentId);
  }
  return out;
}

// Greeting tokens that can precede a vocative ("hey Writer", "yo builder").
// Deliberately narrow: discourse markers like "so"/"no"/"yes" also sit at the
// start of a sentence but usually introduce a MENTION ("so Builder was saying…"),
// which is the exact false positive this matcher exists to kill.
const VOCATIVE_LEAD = String.raw`(?:hey|yo|hi|hello|ok|okay|sup|@)`;
// The connective tissue of a coordinated vocative list ("Writer and Builder, …").
const VOCATIVE_JOIN = String.raw`(?:\s*(?:,|&|and)\s*)`;

// Is `label` used as a form of address (rather than talked about) anywhere in
// `text`? Evaluated per sentence, since a line can mention one facet and address
// another. Pure; case-insensitive.
function isAddressedByName(text: string, label: string): boolean {
  const name = escapeRegExp(label);
  // Any name, so a coordinated list can be recognised as a unit.
  const anyName = `(?:${Object.values(AGENT_LABELS).map(escapeRegExp).join("|")})`;
  // A run of names/greetings that must CONTAIN ours.
  const list = `(?:${anyName}${VOCATIVE_JOIN})*${name}(?:${VOCATIVE_JOIN}${anyName})*`;

  const patterns = [
    // Leading vocative, closed by punctuation: "Writer, what do you think?",
    // "Writer and Builder, join us", "Builder — you seeing this?"
    new RegExp(`^\\s*(?:${VOCATIVE_LEAD}\\s+)*${list}\\s*(?:[,:—–-]|\\?|!|$)`, "i"),
    // After a greeting, no punctuation needed: "hey writer come over".
    new RegExp(`^\\s*${VOCATIVE_LEAD}\\s+${list}\\b`, "i"),
    // Trailing vocative: "what do you think, Writer?"
    new RegExp(`[,—–]\\s*${list}\\s*[?!.]*\\s*$`, "i"),
  ];
  // Bare-name opener on a question: "Writer what do you think?" — common from
  // visitors typing casually, who rarely punctuate a vocative comma.
  const bareQuestionOpener = new RegExp(`^\\s*${list}\\b`, "i");

  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (patterns.some((p) => p.test(s))) return true;
    if (s.includes("?") && bareQuestionOpener.test(s)) return true;
  }
  return false;
}

const AGENT_LABELS: Record<AgentId, string> = {
  career: "Career",
  researcher: "Researcher",
  builder: "Builder",
  writer: "Writer",
  hobby: "Hobby",
};
void agentIds;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- entry points -----------------------------------------------------------

// Force one tick for an agent (POST /admin/tick, smoke tests). Enqueues an
// interrupt tick and awaits its result.
export async function runTick(agentId: AgentId): Promise<ExecResult> {
  return enqueue(agentId, { kind: "tick", interrupt: true });
}

// Test seam.
export function _resetAddressThrottleForTest(): void {
  lastAddressAt.clear();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
