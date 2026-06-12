// The observation packet (plan §3.4): the agent's ground truth each tick.
// PURE SQL — no LLM. Everything the agent could plausibly know, rendered as the
// user-turn text that sits BELOW the cache breakpoint (current time + world
// state are volatile, so they must never enter the cached prefix; plan §4.3).
//
// Contents (plan §3.4):
//  - world time + day phase; ticks since you last acted
//  - where you are (description, fixtures, who else is here)
//  - visitors present in town
//  - inbox (DMs + broadcasts since last tick)
//  - events since last tick (scoped by location/visibility)
//  - your status + current activity
//  - core memory files (always loaded) + recall results for the situation

import { gt, sql } from "drizzle-orm";
import type { AgentId, LocationId, WorldEvent } from "@town/contract";
import { db, schema } from "../db/client.js";
import { getAgent, type AgentRow } from "../engine/agents.js";
import { getLocation, agentsAtLocation } from "../engine/locations.js";
import { perceivedEventsSince } from "../engine/events.js";
import { inboxFor, type MessageRow } from "../engine/messages.js";
import { coreMemorySnapshot } from "../engine/memory.js";
import {
  visitorsAtLocation,
  arrivalTimesAtLocation,
  type VisitorRow,
} from "../engine/visitors.js";
import { clockLine } from "./clock.js";

const { visitors } = schema;

export interface ObservationPacket {
  // The rendered user-turn text the model sees.
  text: string;
  // The event high-water id at packet build time — persisted as the agent's new
  // perception cursor so the next tick sees only newer events.
  highWaterEventId: string;
  // The message high-water id at build time — the message half of the cursor.
  highWaterMessageId: number;
  // Inbox message ids delivered this tick (the tick marks them read after).
  deliveredMessageIds: number[];
  // The agent's current location (the tool layer gates against this).
  location: LocationId;
}

// We track the per-agent perception cursor in memory_files as a tiny meta row
// (path "/.cursor"). Simpler than a new column and survives restarts via the DB.
const CURSOR_PATH = "/.cursor";

async function readCursor(agentId: AgentId): Promise<{ eventId: string; messageId: number }> {
  const [row] = await db
    .select()
    .from(schema.memoryFiles)
    .where(
      sql`${schema.memoryFiles.agentId} = ${agentId} and ${schema.memoryFiles.path} = ${CURSOR_PATH}`,
    );
  if (!row) return { eventId: "0", messageId: 0 };
  try {
    const parsed = JSON.parse(row.content) as { eventId?: string; messageId?: number };
    return { eventId: parsed.eventId ?? "0", messageId: parsed.messageId ?? 0 };
  } catch {
    return { eventId: "0", messageId: 0 };
  }
}

export async function writeCursor(
  agentId: AgentId,
  eventId: string,
  messageId: number,
): Promise<void> {
  const content = JSON.stringify({ eventId, messageId });
  const existing = await db
    .select()
    .from(schema.memoryFiles)
    .where(
      sql`${schema.memoryFiles.agentId} = ${agentId} and ${schema.memoryFiles.path} = ${CURSOR_PATH}`,
    );
  if (existing.length) {
    await db
      .update(schema.memoryFiles)
      .set({ content, updatedAt: new Date() })
      .where(
        sql`${schema.memoryFiles.agentId} = ${agentId} and ${schema.memoryFiles.path} = ${CURSOR_PATH}`,
      );
  } else {
    await db.insert(schema.memoryFiles).values({ agentId, path: CURSOR_PATH, content });
  }
}

async function visitorsPresentCount(): Promise<number> {
  // Visitor presence is keyed to live SSE connections; for the packet we count
  // recently-seen visitors (within 2 min) as "present in town".
  const cutoff = new Date(Date.now() - 2 * 60_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(visitors)
    .where(gt(visitors.lastSeenAt, cutoff));
  return Number(row?.n ?? 0);
}

// Human-ish recency phrase for how long ago a visitor arrived at this location.
function arrivalPhrase(ms: number | undefined, now: number): string {
  if (ms === undefined) return "";
  const mins = Math.floor((now - ms) / 60_000);
  if (mins <= 0) return " (just walked in)";
  if (mins === 1) return " (arrived a minute ago)";
  if (mins < 5) return ` (arrived ${mins} minutes ago)`;
  return " (has been around a little while)";
}

// Render the location-aware Visitors section (design doc §2; de-prescribed in
// M2.1). PLAIN FACT, no instruction: visitor presence is reported the same way
// any other co-presence is — who's here and how recently they arrived. Whether
// to acknowledge a visitor is the agent's choice (the protocol's stance: people
// share the town, they aren't an audience owed a performance), so this section
// carries no "say something" / "don't leave them standing there" nudge. Pure so
// the phrasing is unit-testable. `here` is ordered most-recently-seen first;
// `arrivalMs` maps visitorId → arrival epoch ms.
export function renderVisitorsSection(
  here: { id: string; name: string }[],
  arrivalMs: Map<string, number>,
  townCount: number,
  now: number,
): string {
  if (here.length === 0) {
    if (townCount > 0) {
      return `No visitors here with you; ${townCount} ${townCount === 1 ? "visitor is" : "visitors are"} elsewhere in town.`;
    }
    return `No visitors in town right now.`;
  }
  const lines = here
    .map((v) => `${v.name} is here with you${arrivalPhrase(arrivalMs.get(v.id), now)}`)
    .join("; ");
  const elsewhere = Math.max(0, townCount - here.length);
  const tail =
    elsewhere > 0
      ? ` (${elsewhere} more ${elsewhere === 1 ? "visitor" : "visitors"} elsewhere in town.)`
      : "";
  return `${lines}.${tail}`;
}

function renderInbox(msgs: MessageRow[]): string {
  if (msgs.length === 0) return "Nothing new in your inbox.";
  return msgs
    .map((m) =>
      m.toAgent === null
        ? `- broadcast from ${m.fromAgent}: ${m.body}`
        : `- DM from ${m.fromAgent}: ${m.body}`,
    )
    .join("\n");
}

// Render the events-since-last-tick section from the PERSPECTIVE of `viewer`
// (the ticking agent): an addressed agent.spoke shows whether it was aimed at
// the viewer (`said (to you)`) or another facet (`said to <name>`). The
// conversation.* cases stay (historical world_events rows still parse + render).
export function renderEvents(events: WorldEvent[], location: LocationId, viewer: AgentId): string {
  if (events.length === 0) return "Nothing notable has happened since your last tick.";
  return events
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case "agent.moved":
          return `- ${p.agent} moved to ${p.to}`;
        case "agent.activity":
          return `- ${p.agent} is now ${p.activity}`;
        case "agent.spoke": {
          if (!p.text) return `- ${p.agent} said something (elsewhere)`;
          if (p.to === viewer) return `- ${p.agent} said (to you): "${p.text}"`;
          if (p.to) return `- ${p.agent} said to ${p.to}: "${p.text}"`;
          return `- ${p.agent} said: "${p.text}"`;
        }
        case "agent.thought":
          return p.text ? `- ${p.agent} thought aloud: "${p.text}"` : `- ${p.agent} was thinking`;
        case "conversation.started":
          return `- a conversation started at ${p.location} (${(p.participants as string[])?.join(", ")})`;
        case "conversation.turn":
          return p.text ? `- ${p.agent} (in conversation): "${p.text}"` : `- a conversation continued`;
        case "conversation.ended":
          return `- a conversation ended`;
        case "message.sent":
          return p.broadcast ? `- ${p.from} broadcast a message` : `- a message was sent`;
        case "artifact.created":
          return `- ${p.agent} made a ${p.kind}: "${p.title}"${p.location ? ` (at the ${p.fixture} in ${p.location})` : ""}`;
        case "artifact.updated":
          return `- ${p.agent} updated "${p.title}"`;
        case "bulletin.posted":
          return `- ${p.agent} posted a bulletin: "${p.title}"`;
        case "capability.requested":
          return `- ${p.agent} requested a new capability: ${p.summary}`;
        case "visitor.arrived":
          return `- a visitor (${p.name}) arrived in town`;
        case "visitor.left":
          return `- ${p.name} left`;
        case "visitor.moved":
          return p.to === location
            ? `- ${p.name} walked in here`
            : `- ${p.name} walked over to ${p.to}`;
        case "visitor.interacted":
          return `- ${p.name} ${p.fixture === "phone" ? "picked up the phone" : `touched the ${p.fixture}`} in the ${p.location}`;
        case "world.effect":
          return `- the ${p.fixture} ${p.effect}${p.agent ? ` (${p.agent})` : ""} in the ${p.location}`;
        case "chat.joined":
          return `- ${p.agent} joined a conversation`;
        case "conversation.converted":
          return `- a conversation turned into a chat with a visitor`;
        case "chat.started":
          return `- ${p.agent} started talking with a visitor`;
        case "chat.ended":
          return `- ${p.agent} finished a visitor conversation`;
        case "world.time":
          return `- the time shifted to ${p.phase}`;
        default:
          // All event types are handled above; `e` narrows to never here.
          return `- something happened (${(e as WorldEvent).type})`;
      }
    })
    .join("\n");
}

// Compute "ticks since you last acted" from the agent's lastTickAt and cadence.
function ticksSince(agent: AgentRow, cadenceMinutes: number): number {
  if (!agent.lastTickAt) return 0;
  const mins = (Date.now() - agent.lastTickAt.getTime()) / 60_000;
  return Math.max(0, Math.floor(mins / Math.max(1, cadenceMinutes)));
}

export async function buildObservation(
  agentId: AgentId,
  opts: { cadenceMinutes: number; recallText?: string } = { cadenceMinutes: 12 },
): Promise<ObservationPacket> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const location = agent.locationId as LocationId;

  const cursor = await readCursor(agentId);
  const [loc, here, perceivedRes, inboxRes, visitorCount, visitorsHere, core] = await Promise.all([
    getLocation(location),
    agentsAtLocation(location, agentId),
    perceivedEventsSince(cursor.eventId, agentId, location),
    inboxFor(agentId, cursor.messageId),
    visitorsPresentCount(),
    visitorsAtLocation(location),
    coreMemorySnapshot(agentId),
  ]);
  const perceived = perceivedRes.events;
  const inbox = inboxRes.rows;
  const arrivalMs = await arrivalTimesAtLocation(
    location,
    visitorsHere.map((v) => v.id),
  );

  const fixtures = ((loc?.fixtures as Array<{ id: string }>) ?? []).map((f) => f.id).join(", ");
  const others =
    here.length > 0
      ? here.map((a) => a.displayName).join(", ")
      : "no one else is here right now";

  const sections: string[] = [
    `## Right now`,
    `It's ${clockLine()}. ${ticksSince(agent, opts.cadenceMinutes)} tick(s) have passed since you last acted.`,
    ``,
    `## Where you are`,
    `You're at the ${loc?.name ?? location}. ${loc?.description ?? ""}`,
    `Fixtures here: ${fixtures || "(none)"}.`,
    `Also here: ${others}.`,
    ``,
    `## Visitors`,
    renderVisitorsSection(
      visitorsHere.map((v: VisitorRow) => ({ id: v.id, name: v.name })),
      arrivalMs,
      visitorCount,
      Date.now(),
    ),
    ``,
    `## Your inbox`,
    renderInbox(inbox),
    ``,
    `## What's happened since your last tick`,
    renderEvents(perceived, location, agentId),
    ``,
    `## Your status (as the world believes it)`,
    `Status: ${agent.status}. Activity: ${agent.activity ?? "(none set)"}.`,
    ``,
    `## Your core memory`,
    core,
  ];

  if (opts.recallText) {
    sections.push("", "## Things you recall that may be relevant", opts.recallText);
  }

  return {
    text: sections.join("\n"),
    // Advance the cursor only to the highest id we actually examined this tick
    // (not the global max), so events/messages beyond the fetch cap are picked up
    // on the next tick instead of being silently skipped.
    highWaterEventId: perceivedRes.maxConsideredId,
    highWaterMessageId: inboxRes.maxConsideredId,
    deliveredMessageIds: inbox.map((m) => m.id),
    location,
  };
}
