// The ~17-tool surface (plan §4.2) as betaZodTool definitions whose run
// functions call the world engine IN-PROCESS. The SDK generates the JSON
// schemas and runs the agentic loop (toolRunner) — we never hand-roll dispatch.
//
// Each tool closes over a per-tick AgentContext so it knows who is acting and
// (crucially) where they are, for location-gate enforcement (plan §3.3). Gated
// tools called from the wrong place return an IN-FICTION error (a normal tool
// result string, not a thrown error) — which itself produces good behavior: the
// agent walks to the right place.
//
// `strict: true` is set where malformed args would corrupt world state (moves,
// artifact ids, conversation replies). We use zod/v4 because betaZodTool's
// `inputSchema` is typed against zod/v4 in this SDK version.

import * as z from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";
import { agentIds, locationIds, artifactKinds, listBeats, type AgentId, type LocationId, type ShareCard } from "@town/contract";

import { moveAgent, setActivity, getAgent } from "../engine/agents.js";
import { checkGate, isAdjacent, getLocation, agentsAtLocation } from "../engine/locations.js";
import { appendEvent } from "../engine/events.js";
import { sendMessage } from "../engine/messages.js";
import {
  createArtifact,
  updateArtifact,
  getArtifact,
  recentArtifactsBy,
  listArtifacts,
} from "../engine/artifacts.js";
import { recordCapabilityRequest, sendEmailToThomas } from "../engine/outside.js";
import { readInboundMail, unreadInboundFor } from "../engine/inbound-mail.js";
import {
  memView,
  memCreate,
  memStrReplace,
  memInsert,
  memDelete,
  memRename,
} from "../engine/memory.js";
import * as hindsight from "./hindsight.js";
import * as vault from "./vault.js";
import * as github from "./github.js";
import { tryRecordEffect } from "./fixtures.js";
import { playBeat } from "./director.js";
import { savePreset, listPresetsFor } from "../engine/presets.js";
import {
  objectsAtLocation,
  findObjectAtLocation,
  appendNote,
  attachedArtifactsFor,
  recentObjectEvents,
  createObject,
  moveObject,
  removeObject,
  attachArtifact,
  objectsByOwner,
} from "../engine/objects.js";
import { OBJECT_TEMPLATES } from "../engine/object-templates.js";
import { getArtifactState, setArtifactStateKey } from "../engine/artifact-state.js";
import { readWebPage } from "./webread.js";
import { randomUUID } from "node:crypto";
import { zoneExists, zonesForLocation } from "../engine/zones.js";
import { renderPlace, renderOthersLine } from "./observation.js";
import { getVisitor, escortVisitorTo } from "../engine/visitors.js";
import { getSession } from "./chat.js";
import {
  searchShareables,
  renderShareableHits,
  shareCardFromArtifact,
  shareCardForReferenceId,
  shareCardForProofId,
  type ShareableKind,
} from "../engine/share-cards.js";

// Mutable per-tick context. `location` is read live from the row by the engine,
// but we cache the start-of-tick location and let move_to update it so a tick
// that walks somewhere and then uses a gated tool there works in one round.
export interface AgentContext {
  agentId: AgentId;
  location: LocationId;
  // The visitor chat session this turn is replying in, when applicable (M3). Set
  // on a visitor turn so leave_chat knows it's in a conversation and gets added
  // to the tool surface; undefined on idle ticks.
  chatSessionId?: string | null;
  // Set by the leave_chat tool when the agent decides a chat has run its course.
  // The toolRunner is mid-loop when leave_chat fires, so it cannot end the
  // session synchronously; it stashes the reason here and the loop's visitor turn
  // ends the session AFTER the final message lands.
  endRequested?: string;
  // Chat-only narration channel: tools call this AT THE POINT OF SUCCESS so the
  // panel's inline `action` frames can never describe a refused action (the old
  // tool_use-block scan narrated "walks to the office" even when move_to had
  // declined the hop — observed live). Undefined on idle ticks.
  onAction?: (tool: string, detail: string) => void | Promise<void>;
  // Share cards the agent dropped this turn (M2.2 — Part 4). A share tool pushes
  // here AND streams via onShare immediately; the loop persists these onto the
  // agent's chat message after the final text lands, so a dropped panel rehydrates
  // them. Set (to []) only on visitor turns.
  pendingShareCards?: ShareCard[];
  onShare?: (card: ShareCard) => void | Promise<void>;
}

// Tools the idle tick gets. The chat subset (plan §4.1) is a filtered view.
export type RunnableTool = BetaRunnableTool<unknown>;

// --- Token hygiene (cost lever) -------------------------------------------
// Reference reads (repo files, vault notes, artifacts, recall) used to dump
// their full body verbatim into the continuous thread — 3–5K tokens each, the
// SAME artifact re-read 6×. That bloat rode in EVERY subsequent tick's cache
// read and dragged the thread toward the compaction trigger. Two cheap guards:
//   1. clampText: cap a read's output so one file/note can't dominate the thread.
//   2. dedupRead: a re-read of the SAME unchanged thing returns a short pointer
//      instead of re-dumping the body (the agent already has it above).
function clampText(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[… truncated ${omitted.toLocaleString()} more characters — ${hint} to see the rest.]`;
}

// Per-agent recent-read fingerprints (process memory; resets on restart, which
// just re-warms the guard). Bounded so it only catches genuinely rapid re-reads.
const RECENT_READS_MAX = 8;
const recentReads = new Map<string, { key: string; hash: number }[]>();
function fingerprint(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}
// Returns a pointer string if this exact key+content was read recently (so the
// caller can skip re-dumping it); else records it and returns null.
function dedupRead(agentId: string, key: string, content: string, label: string): string | null {
  const hash = fingerprint(content);
  const list = recentReads.get(agentId) ?? [];
  const seen = list.find((e) => e.key === key);
  if (seen && seen.hash === hash) {
    return `You already opened ${label} earlier in this conversation and it hasn't changed — scroll back rather than re-reading it (you won't see anything new).`;
  }
  const next = list.filter((e) => e.key !== key);
  next.push({ key, hash });
  while (next.length > RECENT_READS_MAX) next.shift();
  recentReads.set(agentId, next);
  return null;
}

const artifactKindEnum = z.enum(artifactKinds as unknown as [string, ...string[]]);

// Search the 648-template object library by name / tag / category. Pure, so
// it's unit-testable; returns names best-first with footprint hints.
export function searchObjectTemplates(query: string, limit = 20): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { name: string; score: number }[] = [];
  for (const [name, t] of Object.entries(OBJECT_TEMPLATES)) {
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 4;
      else if (name.includes(term)) score += 2;
      if (t.tags.some((tag) => tag === term)) score += 2;
      else if (t.tags.some((tag) => tag.includes(term))) score += 1;
      if (t.category === term) score += 1;
    }
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

function describeTemplate(name: string): string {
  const t = OBJECT_TEMPLATES[name];
  if (!t) return name;
  return `${name} (${t.category}, ${t.w}×${t.h} tiles${t.collides ? "" : ", walkable"})`;
}

function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Resolve a named spot (an object or an explicit zone) to a zone id WITHIN
// `to` — shared by move_to and invite_visitor (Phase C / C.5, space
// addressing). The wire only ever carries the resolved WORD, never pixels.
// An object resolves to ITS zone; an explicit zone is validated against the
// destination location. Unresolvable → undefined, never an error (degrades
// to "just the room", per the design's "unknown ref never errors" stance).
async function resolveTargetZone(
  to: LocationId,
  toObject?: string,
  toZone?: string,
): Promise<string | undefined> {
  if (toObject) {
    const obj = await findObjectAtLocation(to, toObject).catch(() => undefined);
    return obj?.zone;
  }
  if (toZone && zoneExists(toZone, to)) return toZone;
  return undefined;
}

// Build the full tool array for one tick, bound to `ctx`.
export function buildTools(ctx: AgentContext): RunnableTool[] {
  // --- World -----------------------------------------------------------------
  const move_to = betaZodTool({
    name: "move_to",
    description:
      "Walk to another location: town, office, library, workshop, cafe, park. If it's across town you'll cut through the town square on the way. Optionally stand somewhere SPECIFIC once you're there — name an object (toObject, e.g. 'bench') or a zone (toZone, e.g. 'park.bench-area'); an unrecognized one just leaves you in the room, never an error. Works even if you're already in that room (a pure reposition). Updates where you are for the rest of this tick.",
    inputSchema: z.object({
      location: z.enum(locationIds as unknown as [string, ...string[]]),
      toObject: z.string().max(60).optional(),
      toZone: z.string().max(60).optional(),
    }),
    run: async ({ location, toObject, toZone }) => {
      const to = location as LocationId;
      const wantsSpot = Boolean(toObject || toZone);
      if (to === ctx.location && !wantsSpot) return `You're already at the ${to}.`;

      const targetZone = await resolveTargetZone(to, toObject, toZone);
      const spotLabel = toObject ?? toZone;

      if (to === ctx.location) {
        // Pure within-room reposition — no location change to emit otherwise.
        await moveAgent(ctx.agentId, to, targetZone);
        if (!targetZone) return `There's no "${spotLabel}" here to walk to — you stay put.`;
        await ctx.onAction?.("move_to", `walks over to the ${spotLabel}`);
        return `You walk over to the ${spotLabel}.`;
      }

      const adjacent = await isAdjacent(ctx.location, to);
      if (!adjacent) {
        // Hub-and-spoke: every place connects through town, so a cross-town
        // walk is two hops. Just do both — refusing stranded agents on a
        // topology detail no human would trip on (and mid-chat, the refusal
        // read as "the move is broken" to both the agent and the visitor).
        await moveAgent(ctx.agentId, "town");
        ctx.location = "town";
      }
      await moveAgent(ctx.agentId, to, targetZone);
      ctx.location = to; // gated tools later this tick see the new place
      const loc = await getLocation(to);
      const name = loc?.name ?? to;
      await ctx.onAction?.(
        "move_to",
        adjacent ? `walks over to the ${name}` : `cuts through the town square to the ${name}`,
      );
      const spotNote = targetZone ? `, over by the ${spotLabel}` : "";
      return `You walk to the ${name}${spotNote}. ${loc?.description ?? ""}`;
    },
  });

  // invite_visitor (Phase C.5): bring the visitor you're chatting with along —
  // a full, server-driven walk on their end too (not just yours), so this is
  // chat-only and deliberate, not a casual add-on to every room change.
  const invite_visitor = betaZodTool({
    name: "invite_visitor",
    description:
      "Ask the visitor you're talking with to come along — you both walk to the place (and, optionally, a specific spot there, via toObject/toZone — same as move_to). Their character walks the whole way with you, automatically; this is for a real invite ('come see the workshop'), not idle movement. Only works while you're in a conversation with them.",
    inputSchema: z.object({
      location: z.enum(locationIds as unknown as [string, ...string[]]),
      toObject: z.string().max(60).optional(),
      toZone: z.string().max(60).optional(),
    }),
    run: async ({ location, toObject, toZone }) => {
      if (!ctx.chatSessionId) {
        return "You can only bring someone along while you're talking with them.";
      }
      const session = await getSession(ctx.chatSessionId).catch(() => null);
      if (!session?.visitorId) {
        return "There's no visitor in this conversation to bring along.";
      }
      const visitor = await getVisitor(session.visitorId).catch(() => undefined);
      if (!visitor) return "Can't find that visitor anymore.";

      const to = location as LocationId;
      const targetZone = await resolveTargetZone(to, toObject, toZone);
      const spotLabel = toObject ?? toZone;

      // Move yourself too (mirrors move_to's own hub-and-spoke hop), unless
      // it's a pure within-room reposition with both of you already here.
      if (to !== ctx.location) {
        const adjacent = await isAdjacent(ctx.location, to);
        if (!adjacent) {
          await moveAgent(ctx.agentId, "town");
          ctx.location = "town";
        }
        await moveAgent(ctx.agentId, to, targetZone);
        ctx.location = to;
      } else if (targetZone) {
        await moveAgent(ctx.agentId, to, targetZone);
      }

      await escortVisitorTo(session.visitorId, ctx.agentId, to, targetZone);

      const loc = await getLocation(to);
      const name = loc?.name ?? to;
      const spotNote = targetZone ? `, over by the ${spotLabel}` : "";
      await ctx.onAction?.("invite_visitor", `brings the visitor along to the ${name}`);
      return `You bring them along to the ${name}${spotNote}. ${loc?.description ?? ""}`;
    },
  });

  const set_activity = betaZodTool({
    name: "set_activity",
    description:
      "Set your current activity line — what you're visibly doing right now (e.g. 'drafting a post on eval design', 'reading a paper'). Others and visitors can see this.",
    inputSchema: z.object({ text: z.string().min(1).max(140) }),
    run: async ({ text }) => {
      await setActivity(ctx.agentId, text);
      await ctx.onAction?.("set_activity", `is now ${text}`);
      return `Your activity is now: ${text}`;
    },
  });

  const look_around = betaZodTool({
    name: "look_around",
    description:
      "Take a closer look at where you are right now — the place, its fixtures, and who else is here.",
    inputSchema: z.object({}),
    run: async () => {
      const [loc, here, objectsHere] = await Promise.all([
        getLocation(ctx.location),
        agentsAtLocation(ctx.location, ctx.agentId),
        objectsAtLocation(ctx.location),
      ]);
      // Match the legacy fixtures order so a clean room reads identically to the
      // delta packet; renderPlace degrades to a flat list when nothing's salient.
      const fixtureOrder = ((loc?.fixtures as Array<{ id: string }>) ?? []).map((f) => f.id);
      const ordered = [...objectsHere].sort((a, b) => {
        const ia = fixtureOrder.indexOf(a.displayName);
        const ib = fixtureOrder.indexOf(b.displayName);
        return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
      });
      const placeLines = renderPlace(
        ordered.map((o) => ({
          id: o.id,
          displayName: o.displayName,
          zone: o.zone,
          state: o.state as Record<string, unknown> | null,
          notes: o.notes,
        })),
        [],
      );
      const zonesHere = zonesForLocation(ctx.location);
      const others = renderOthersLine(
        here.map((a) => ({ displayName: a.displayName, zone: a.zone as string | null })),
        (id) => zonesHere.find((z) => z.id === id)?.label,
      );
      return `You're at the ${loc?.name ?? ctx.location}. ${loc?.description ?? ""}\n${placeLines.join("\n")}\nAlso here: ${others}.`;
    },
  });

  // inspect_object: a close look at ONE object where you are — its state, its
  // recent history, and any artifacts attached to it. A pure PULL (zero world
  // mutation, no obligation created) — the read_artifact of physical things.
  const inspect_object = betaZodTool({
    name: "inspect_object",
    description:
      "Take a close look at ONE thing where you are — its current state, the recent marks/effects on it, and anything pinned or filed to it (with ids you can read_artifact). A quiet look, nothing more; it changes nothing.",
    inputSchema: z.object({ object: z.string().min(1).max(60) }),
    run: async ({ object }) => {
      const obj = await findObjectAtLocation(ctx.location, object);
      if (!obj) {
        const here = (await objectsAtLocation(ctx.location)).map((o) => o.displayName).join(", ");
        return `There's no ${object} here. What's around: ${here || "nothing in particular"}.`;
      }
      const state = obj.state as Record<string, unknown>;
      const stateStr =
        Object.keys(state).length === 0
          ? "nothing remarkable about its state"
          : Object.entries(state)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join(", ");
      const lines = [`The ${obj.displayName}${obj.description ? ` — ${obj.description}` : ""}.`, `State: ${stateStr}.`];
      const notes = (obj.notes ?? []) as { agent: string; text: string }[];
      if (notes.length) {
        lines.push(
          `Notes left here:\n${notes.slice(-5).map((n) => `  • ${n.agent}: "${n.text}"`).join("\n")}`,
        );
      }
      const attached = await attachedArtifactsFor(obj.id);
      if (attached.length) {
        lines.push(
          `Attached:\n${attached
            .slice(0, 8)
            .map((a) => `  • ${a.kind} "${a.title}" (id ${a.id})`)
            .join("\n")}`,
        );
      }
      const history = await recentObjectEvents(obj.id, obj.displayName);
      if (history.length) {
        lines.push(`Recently:\n${history.map((h) => `  • ${h.line}`).join("\n")}`);
      }
      return lines.join("\n");
    },
  });

  // leave_note: the lightest "I shaped my space" act — jot a short persistent
  // note on an object or named zone HERE. Bounded (current location, short text,
  // the same 20/hour effect limiter play_beat shares) so it can't become a
  // fidget; the note persists and is re-read next time. One of object|zone required.
  const leave_note = betaZodTool({
    name: "leave_note",
    description:
      "Jot a short note on something where you are — a line on the workbench, a card by the sign, a thought left in a corner. It stays put and you'll see it again later. Name an object (e.g. 'workbench') OR a zone here. Like jotting on a real desk, not filing paperwork — only when you actually have something to leave.",
    inputSchema: z.object({
      object: z.string().max(60).optional(),
      zone: z.string().max(60).optional(),
      text: z.string().min(1).max(280),
    }),
    run: async ({ object, zone, text }) => {
      if (!object && !zone) return "Leave the note on something — name an object here or a zone.";
      let objectId: string | null = null;
      let resolvedZone: string | undefined = zone;
      if (object) {
        const obj = await findObjectAtLocation(ctx.location, object);
        if (!obj) {
          const here = (await objectsAtLocation(ctx.location)).map((o) => o.displayName).join(", ");
          return `There's no ${object} here to leave a note on. What's around: ${here || "nothing in particular"}.`;
        }
        objectId = obj.id;
      } else if (zone && !zoneExists(zone, ctx.location)) {
        return `There's no spot called "${zone}" here.`;
      }
      // Rate limit AFTER validation so a wrong target doesn't burn a slot.
      if (!tryRecordEffect(ctx.agentId)) {
        return "You've been leaving a lot of marks around lately — let it rest for a bit.";
      }
      const res = await appendNote({ objectId, zone: resolvedZone }, ctx.agentId, ctx.location, text);
      if (!res.ok) return "You can't leave a note there from here.";
      await ctx.onAction?.("leave_note", "jots a note");
      return objectId
        ? `You leave a note on the ${object}. It'll be there when you come back.`
        : `You leave a note ${resolvedZone}. It'll be there when you come back.`;
    },
  });

  // play_beat (Director/Effect protocol): the ONE spine tool for running a bit —
  // a named catalog beat that changes an object's state here (a phone rings, a
  // lamp flickers) or reaches across the glass onto a visitor's screen (a
  // flourish, an emote) — OR one of your own saved presets (see save_preset
  // below). The agent picks a beat (or preset) by name and parameterizes it; it
  // can never inject markup, and a preset can never define a new mechanic, only
  // a saved set of params for one that already exists. The catalog description
  // is GENERATED from @town/contract so adding a MECHANIC is a data row there —
  // no tool change, no new token cost beyond one line — but the catalog itself
  // stays deliberately small; variety lives in presets, not in more beats.
  // Available on idle ticks AND chat (a core tool).
  const play_beat = betaZodTool({
    name: "play_beat",
    description: [
      "Run a bit: a small, pre-built effect — change something here in the world, or pop something onto the visitor's screen — by name. It's seasoning, not a tic; a bit that lands once beats five that don't (shares your effect budget). The bits you can run:",
      ...listBeats().map((b) => {
        const shape = b.params instanceof z.ZodObject ? Object.keys(b.params.shape) : [];
        const paramHint = shape.length ? ` params: {${shape.join(", ")}}` : " no params";
        return `- "${b.id}" (${b.surface}): ${b.description}${paramHint}.`;
      }),
      'Pass the beat id (or a preset name from list_my_presets) as `beat`, its params as `params`, and (for object beats) optionally name the object via `object` — omit it and a sensible one here is chosen.',
    ].join("\n"),
    inputSchema: z.object({
      beat: z.string(),
      object: z.string().max(60).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async (a) => playBeat(ctx, { beat: a.beat, object: a.object, params: a.params ?? {} }),
  });

  // save_preset (Phase B.5 — "customization within bounds"): save a NAMED set
  // of params for an EXISTING beat as your own. It's still re-validated against
  // that beat's schema at save time, so a preset can't be (or become) anything
  // a direct play_beat call couldn't do — it's a personal default, not a new
  // mechanic. One name per agent; re-saving overwrites.
  const save_preset = betaZodTool({
    name: "save_preset",
    description:
      "Save a named variant of one of your bits — your own emote set, your own popup-card tone — so you can call it by that name later via play_beat instead of re-specifying the params each time. Still validated against the underlying bit's schema; this can't create a new kind of effect, only a personal default for one that exists.",
    inputSchema: z.object({
      name: z.string().min(1).max(40),
      beat: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async ({ name, beat, params }) => {
      const res = await savePreset(ctx.agentId, name, beat, params ?? {});
      if (!res.ok) return res.reason;
      return `Saved "${name}" — play_beat({beat:"${name}"}) runs it from now on.`;
    },
  });

  const list_my_presets = betaZodTool({
    name: "list_my_presets",
    description: "List the bit presets you've saved for yourself — each one's name and which beat it's a variant of.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await listPresetsFor(ctx.agentId);
      if (rows.length === 0) return "You haven't saved any presets yet — save_preset to make one.";
      return rows.map((r) => `- "${r.name}" (a variant of "${r.beat}")`).join("\n");
    },
  });

  // --- Social ----------------------------------------------------------------
  // NOTE (M3 speech unification): there is no `say` tool. Speaking is just
  // writing plain text — it's the agent's utterance, heard by whoever's present
  // (loop.ts emitUtterance turns it into agent.spoke / agent.thought).
  const send_dm = betaZodTool({
    name: "send_dm",
    description:
      "Send a private note to another facet, delivered to their next tick's inbox. Works from anywhere — it's async, like leaving a message.",
    inputSchema: z.object({
      agent: z.enum(agentIds as unknown as [string, ...string[]]),
      text: z.string().min(1).max(1000),
    }),
    run: async ({ agent, text }) => {
      const to = agent as AgentId;
      if (to === ctx.agentId) return "You don't need to DM yourself.";
      await sendMessage(ctx.agentId, to, text);
      return `DM sent to ${to}. They'll see it next time they wake.`;
    },
  });

  const broadcast = betaZodTool({
    name: "broadcast",
    description:
      "Send a message to all the other facets at once, delivered to each of their next ticks. For news everyone should know.",
    inputSchema: z.object({ text: z.string().min(1).max(1000) }),
    run: async ({ text }) => {
      await sendMessage(ctx.agentId, null, text);
      return `Broadcast sent to everyone.`;
    },
  });

  // --- Making ----------------------------------------------------------------
  const create_artifact = betaZodTool({
    name: "create_artifact",
    description:
      "Make a durable thing that persists in the world and that visitors can find. Kinds: blog_post, project_log, research_note, fun_list, diary_entry. (Bulletins use post_bulletin; daily_digest is the world's job.) It's anchored to your facet's home fixture automatically.",
    inputSchema: z.object({
      kind: artifactKindEnum,
      title: z.string().min(1).max(160),
      body: z.string().min(1).max(20_000),
    }),
    run: async ({ kind, title, body }) => {
      if (kind === "bulletin") return "Use post_bulletin for bulletins (it's gated to the town notice board).";
      if (kind === "daily_digest") return "The daily digest is written by the town itself, not by a facet.";
      // Making discipline (in-fiction): a flood of new artifacts reads as spam,
      // not life. After a few in one day, the desk pushes back — revise instead.
      const today = (await recentArtifactsBy(ctx.agentId, 24)).filter(
        (a) => a.kind !== "diary_entry",
      );
      if (today.length >= 3) {
        const recentList = today
          .slice(0, 4)
          .map((a) => `- ${a.kind} "${a.title}" (id ${a.id})`)
          .join("\n");
        return (
          `Your desk is already covered in today's work — making a fourth new thing ` +
          `would mean none of them get the attention they deserve. Today you made:\n${recentList}\n` +
          `If this idea is real, it probably belongs INSIDE one of those — use ` +
          `update_artifact to revise or extend it. Tomorrow is another day for new things.`
        );
      }
      const row = await createArtifact({
        agentId: ctx.agentId,
        kind: kind as never,
        title,
        body,
      });
      await ctx.onAction?.("create_artifact", `writes "${title}"`);
      return `Created ${kind} "${title}" (id ${row.id}).`;
    },
  });

  const update_artifact = betaZodTool({
    name: "update_artifact",
    description: "Revise one of your existing artifacts by its id. You can change the title, body, or both.",
    inputSchema: z.object({
      id: z.string().min(1),
      title: z.string().max(160).optional(),
      body: z.string().max(20_000).optional(),
    }),
    run: async ({ id, title, body }) => {
      const existing = await getArtifact(id);
      if (!existing) return `No artifact with id ${id}.`;
      if (existing.agentId !== ctx.agentId) return "That's not yours to edit.";
      await updateArtifact(id, { title, body });
      await ctx.onAction?.("update_artifact", `revises "${title ?? existing.title}"`);
      return `Updated "${title ?? existing.title}".`;
    },
  });

  const list_my_artifacts = betaZodTool({
    name: "list_my_artifacts",
    description:
      "List the things YOU'VE made — your own artifacts — most recent first, with each one's id, kind, title, and whether it's published. Use this whenever you need an artifact's id (to update_artifact or publish_blog_post it) or to take stock of your own work.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await listArtifacts({ agent: ctx.agentId }, 20);
      if (rows.length === 0) return "You haven't made anything yet.";
      return rows
        .map(
          (a) =>
            `- ${a.kind} "${a.title}" (id ${a.id})${a.published ? " [published]" : ""}`,
        )
        .join("\n");
    },
  });

  const read_artifact = betaZodTool({
    name: "read_artifact",
    description:
      "Read the FULL contents of any artifact by its id — yours or another facet's (a blog post, research note, project log, fun list, or a bulletin/sign). Use this to actually read something you've seen referenced or heard about. Ids come from list_my_artifacts, read_board, or an event line that mentions one (e.g. 'made a research_note … (id …)').",
    inputSchema: z.object({ id: z.string().min(1) }),
    run: async ({ id }) => {
      const a = await getArtifact(id);
      if (!a) return `There's no artifact with id ${id} (it may have been removed, or the id's off).`;
      const full = `"${a.title}" — a ${a.kind} by ${a.agentId}${a.published ? " (published)" : ""}\n\n${a.body}`;
      const dup = dedupRead(ctx.agentId, `artifact:${id}`, full, `"${a.title}"`);
      if (dup) return dup;
      return clampText(full, 12_000, "open it again later if you genuinely need the rest");
    },
  });

  const read_board = betaZodTool({
    name: "read_board",
    description:
      "Read what's pinned to the town square notice board right now — the bulletins (the 'signs' facets post for everyone). Returns each one's title, who posted it, and its full text. Use this whenever you hear a sign or bulletin was posted and want to actually read it.",
    inputSchema: z.object({}),
    run: async () => {
      const bulletins = await listArtifacts({ kind: "bulletin" }, 12);
      if (bulletins.length === 0) return "The notice board is empty right now.";
      return bulletins
        .map((b) => `— "${b.title}" (posted by ${b.agentId}, id ${b.id})\n${b.body}`)
        .join("\n\n");
    },
  });

  const post_bulletin = betaZodTool({
    name: "post_bulletin",
    description:
      "Pin a bulletin to the town square notice board for everyone — facets and visitors — to read. You must be in town to do this.",
    inputSchema: z.object({
      title: z.string().min(1).max(160),
      body: z.string().min(1).max(4_000),
    }),
    run: async ({ title, body }) => {
      const gate = checkGate("post_bulletin", ctx.location);
      if (!gate.allowed) return gate.reason!;
      await createArtifact({
        agentId: ctx.agentId,
        kind: "bulletin",
        title,
        body,
        location: "town",
        fixture: "notice board",
      });
      return `Pinned "${title}" to the notice board.`;
    },
  });

  const publish_blog_post = betaZodTool({
    name: "publish_blog_post",
    description:
      "Publish one of your blog_post artifacts — make it public via the cafe press. You must be at the cafe. Pass the artifact id.",
    inputSchema: z.object({ artifact_id: z.string().min(1) }),
    run: async ({ artifact_id }) => {
      const gate = checkGate("publish_blog_post", ctx.location);
      if (!gate.allowed) return gate.reason!;
      const art = await getArtifact(artifact_id);
      if (!art) return `No artifact with id ${artifact_id}.`;
      if (art.kind !== "blog_post") return "Only blog posts get published at the press.";
      await updateArtifact(artifact_id, { published: true });
      return `Published "${art.title}" — it's public now.`;
    },
  });

  // --- The workshop (programmable world: build, mount, place) ----------------
  const build_interactive = betaZodTool({
    name: "build_interactive",
    description:
      "Build a real, usable web app as a single self-contained HTML file — a playable game, a generative art piece, a tiny tool, a guestbook — and make it a durable artifact visitors can open and USE. Rules of the medium: ONE file (inline <style> and <script>, no external scripts/stylesheets/fetch — the frame is sandboxed offline; images only as data: URIs or https <img>). Your app gets a free persistent store via the injected `window.town` bridge: `town.artifactId`; `town.visitor` ({id,name} or null); `await town.getState()` → the whole keyed state object; `await town.setState(key, value)` (JSON value; null deletes); `town.onChange(cb)` → cb(freshState) whenever anyone changes state. That store is SHARED with you — you read/write the same keys via read_artifact_state / write_artifact_state, so you can play turn-based games against visitors (you'll be nudged when someone interacts). After building, mount_artifact it on an object so people can find it in the world.",
    inputSchema: z.object({
      title: z.string().min(1).max(160),
      html: z.string().min(1).max(100_000),
    }),
    run: async ({ title, html }) => {
      // Building discipline: an app is a big swing — two a day is plenty. Revise
      // with update_artifact instead of stamping out variants.
      const todaysApps = await recentArtifactsBy(ctx.agentId, 24, "interactive" as never);
      if (todaysApps.length >= 2) {
        return (
          `You've already built ${todaysApps.length} apps today (${todaysApps
            .map((a) => `"${a.title}"`)
            .join(", ")}). ` +
          `Polish one of those with update_artifact instead — a town full of half-finished apps reads as noise, not craft.`
        );
      }
      const row = await createArtifact({
        agentId: ctx.agentId,
        kind: "interactive" as never,
        title,
        body: html,
      });
      await ctx.onAction?.("build_interactive", `builds "${title}"`);
      return (
        `Built "${title}" (id ${row.id}). It's live — anyone opening it gets your app in a sandboxed frame. ` +
        `Mount it somewhere physical with mount_artifact so visitors can find it, and check on it later with read_artifact_state.`
      );
    },
  });

  const mount_artifact = betaZodTool({
    name: "mount_artifact",
    description:
      "Mount an artifact (yours or another facet's — an app, a page, a note) onto a physical object HERE in the room you're in, so visitors can click the object and open it. Name the object the way you see it (e.g. 'monitor', 'the dumb sign', or something you placed).",
    inputSchema: z.object({
      artifact_id: z.string().min(1),
      object: z.string().min(1).max(80),
    }),
    run: async ({ artifact_id, object }) => {
      const obj = await findObjectAtLocation(ctx.location, object);
      if (!obj) return `There's no "${object}" here in ${ctx.location}. look_around to see what's actually in the room.`;
      const art = await getArtifact(artifact_id);
      if (!art) return `No artifact with id ${artifact_id}.`;
      const r = await attachArtifact(obj.id, artifact_id, ctx.agentId);
      if (!r.ok) return `Couldn't mount it (${r.reason}).`;
      await ctx.onAction?.("mount_artifact", `mounts "${art.title}" on the ${obj.displayName}`);
      return `Mounted "${art.title}" on the ${obj.displayName} — it's now the thing that opens when someone clicks it.`;
    },
  });

  const search_object_library = betaZodTool({
    name: "search_object_library",
    description:
      "Search the town's object library — the ~650 physical props you can place_object into the world (furniture, devices, plants, signs, food, arcade bits...). Search by what it is ('arcade', 'bookshelf', 'neon sign', 'piano'). Returns exact template names with footprint sizes; place_object needs the exact name.",
    inputSchema: z.object({ query: z.string().min(1).max(120) }),
    run: async ({ query }) => {
      const hits = searchObjectTemplates(query, 20);
      if (hits.length === 0) return `Nothing in the library matches "${query}". Try a broader word ('table', 'lamp', 'sign', 'plant', 'game').`;
      return `Library matches for "${query}":\n${hits.map((h) => `- ${describeTemplate(h)}`).join("\n")}`;
    },
  });

  const place_object = betaZodTool({
    name: "place_object",
    description:
      "Place a new physical object from the library into the room you're in — it appears on screen for everyone, permanently, with your name on it. Pass the exact library template name (from search_object_library), what to call it, and optionally which zone of the room to put it in (look_around shows zones). Place things with intent: an arcade cabinet to mount your game on, a shelf for your zines, one good lamp — not clutter.",
    inputSchema: z.object({
      template: z.string().min(1).max(80),
      name: z.string().min(1).max(60),
      zone: z.string().max(60).optional(),
      description: z.string().max(300).optional(),
    }),
    run: async ({ template, name, zone, description }) => {
      if (!OBJECT_TEMPLATES[template]) {
        const near = searchObjectTemplates(template, 5);
        return near.length
          ? `"${template}" isn't an exact library name. Closest: ${near.map(describeTemplate).join(", ")}.`
          : `"${template}" isn't in the library. search_object_library first.`;
      }
      const mine = await objectsByOwner(ctx.agentId);
      if (mine.length >= 30) {
        return (
          `You already have ${mine.length} placed objects around town — the place is starting to look like your storage unit. ` +
          `remove_object something you no longer need before placing more.`
        );
      }
      const targetZone = zone && zoneExists(zone, ctx.location) ? zone : undefined;
      if (zone && !targetZone) {
        const zones = zonesForLocation(ctx.location).map((z) => z.id).join(", ");
        return `"${zone}" isn't a zone here. This room's zones: ${zones}.`;
      }
      const id = `${ctx.location}.${slugifyName(name)}-${randomUUID().slice(0, 4)}`;
      const row = await createObject({
        id,
        agent: ctx.agentId,
        location: ctx.location,
        zone: targetZone ?? `${ctx.location}.center`,
        template,
        displayName: name,
        kind: OBJECT_TEMPLATES[template].category,
        description: description ?? null,
      });
      await ctx.onAction?.("place_object", `sets up ${name}`);
      return (
        `Placed "${name}" (${describeTemplate(template)}) ${targetZone ? `in ${targetZone}` : "here"} — object id ${row.id}. ` +
        `It's on screen now. You can mount_artifact things onto it, leave_note on it, move_object or remove_object it later.`
      );
    },
  });

  const move_object = betaZodTool({
    name: "move_object",
    description:
      "Move a placed (movable) object in this room to a different zone of the room. Seeded town fixtures don't move.",
    inputSchema: z.object({
      object: z.string().min(1).max(80),
      to_zone: z.string().min(1).max(60),
    }),
    run: async ({ object, to_zone }) => {
      const obj = await findObjectAtLocation(ctx.location, object);
      if (!obj) return `There's no "${object}" here.`;
      const r = await moveObject(obj.id, ctx.agentId, to_zone);
      if (!r.ok) {
        if (r.reason === "immovable") return `The ${obj.displayName} is part of the town — it doesn't move.`;
        if (r.reason === "zone-not-here") {
          const zones = zonesForLocation(ctx.location).map((z) => z.id).join(", ");
          return `"${to_zone}" isn't a zone here. This room's zones: ${zones}.`;
        }
        return `Couldn't move it (${r.reason}).`;
      }
      await ctx.onAction?.("move_object", `moves the ${obj.displayName}`);
      return `Moved the ${obj.displayName} to ${to_zone}.`;
    },
  });

  const remove_object = betaZodTool({
    name: "remove_object",
    description:
      "Remove a placed (movable) object from this room — it disappears from the world. Anything an agent placed is fair game (the town is a commons); seeded fixtures can't be removed.",
    inputSchema: z.object({ object: z.string().min(1).max(80) }),
    run: async ({ object }) => {
      const obj = await findObjectAtLocation(ctx.location, object);
      if (!obj) return `There's no "${object}" here.`;
      const r = await removeObject(obj.id, ctx.agentId);
      if (!r.ok) {
        if (r.reason === "immovable") return `The ${obj.displayName} is part of the town — it stays.`;
        return `Couldn't remove it (${r.reason}).`;
      }
      await ctx.onAction?.("remove_object", `clears away the ${obj.displayName}`);
      return `Removed the ${obj.displayName}.`;
    },
  });

  const read_artifact_state = betaZodTool({
    name: "read_artifact_state",
    description:
      "Read the live state store of an interactive artifact (an app you or another facet built) — the same keyed data the app's visitors read and write. Pass a key to get just that value, or omit it for the whole store. This is how you see moves visitors made, guestbook entries, poll results.",
    inputSchema: z.object({
      artifact_id: z.string().min(1),
      key: z.string().max(64).optional(),
    }),
    run: async ({ artifact_id, key }) => {
      const art = await getArtifact(artifact_id);
      if (!art) return `No artifact with id ${artifact_id}.`;
      const state = await getArtifactState(artifact_id);
      const keys = Object.keys(state);
      if (keys.length === 0) return `"${art.title}" has no state yet — nobody has interacted with it.`;
      if (key !== undefined) {
        if (!(key in state)) return `No key "${key}" in "${art.title}" state. Keys: ${keys.join(", ")}.`;
        return clampText(`${key} = ${JSON.stringify(state[key], null, 1)}`, 8_000, "read a narrower key");
      }
      return clampText(
        `State of "${art.title}" (${keys.length} keys):\n${JSON.stringify(state, null, 1)}`,
        8_000,
        "read one key at a time",
      );
    },
  });

  const write_artifact_state = betaZodTool({
    name: "write_artifact_state",
    description:
      "Write one key of an interactive artifact's state store — your hands inside the apps. This is how you make your move in a game a visitor is playing against you, reply in a guestbook, update a scoreboard. `value` is parsed as JSON when it looks like JSON, else stored as a plain string; pass the literal string 'null' to delete the key.",
    inputSchema: z.object({
      artifact_id: z.string().min(1),
      key: z.string().min(1).max(64),
      value: z.string().max(30_000),
    }),
    run: async ({ artifact_id, key, value }) => {
      const art = await getArtifact(artifact_id);
      if (!art) return `No artifact with id ${artifact_id}.`;
      let parsed: unknown = value;
      const trimmed = value.trim();
      if (
        trimmed === "null" ||
        trimmed === "true" ||
        trimmed === "false" ||
        /^-?\d+(\.\d+)?$/.test(trimmed) ||
        trimmed.startsWith("{") ||
        trimmed.startsWith("[") ||
        trimmed.startsWith('"')
      ) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = value;
        }
      }
      const r = await setArtifactStateKey(artifact_id, key, parsed, { agent: ctx.agentId });
      if (!r.ok) {
        if (r.reason === "too-big") return "That value is too large for one key (32KB max) — split it up.";
        if (r.reason === "too-many-keys") return `"${art.title}" already has the maximum number of state keys — clean up old ones (write 'null') first.`;
        return `Couldn't write it (${r.reason}).`;
      }
      return parsed === null ? `Deleted "${key}" from "${art.title}".` : `Wrote "${key}" in "${art.title}". Anyone with the app open sees it live.`;
    },
  });

  // --- Reading the outside web ------------------------------------------------
  const read_web_page = betaZodTool({
    name: "read_web_page",
    description:
      "Fetch and read a public web page (an article, docs, a blog post) as clean text. Use it to actually read something a visitor mentions, research a topic, or pull a piece to share on a screen with share_to_screen. Public sites only.",
    inputSchema: z.object({ url: z.string().min(8).max(1_000) }),
    run: async ({ url }) => {
      const r = await readWebPage(url);
      if (!r.ok) return r.reason ?? "Couldn't read that page.";
      const head = r.title ? `# ${r.title}\n(${r.url})\n\n` : `(${r.url})\n\n`;
      const out = head + (r.text ?? "");
      const dup = dedupRead(ctx.agentId, `web:${r.url}`, out, `that page`);
      if (dup) return dup;
      await ctx.onAction?.("read_web_page", `reads ${r.title ?? url}`);
      return clampText(out, 16_000, "read_web_page it again — the cap is per read");
    },
  });

  const share_to_screen = betaZodTool({
    name: "share_to_screen",
    description:
      "Put a page of text/markdown up on a screen-ish object HERE (the workshop monitor, a TV you placed, a shelf) so visitors can click it and read the same thing you're looking at — for reading an article together, posting today's plan, a menu. Creates a durable shared_page artifact and mounts it. Name the object, or omit it to use the most screen-like thing in the room.",
    inputSchema: z.object({
      title: z.string().min(1).max(160),
      body: z.string().min(1).max(20_000),
      object: z.string().max(80).optional(),
    }),
    run: async ({ title, body, object }) => {
      let target = object ? await findObjectAtLocation(ctx.location, object) : undefined;
      if (object && !target) return `There's no "${object}" here.`;
      if (!target) {
        const here = await objectsAtLocation(ctx.location);
        const screenish = (o: (typeof here)[number]) =>
          /screen|monitor|tv|projector|display/.test(`${o.displayName} ${o.kind ?? ""}`.toLowerCase())
            ? 2
            : o.kind === "artifact_shelf" || o.kind === "publisher"
              ? 1
              : 0;
        target = [...here].sort((a, b) => screenish(b) - screenish(a)).find((o) => screenish(o) > 0);
      }
      if (!target) {
        return "Nothing here works as a screen. place_object something screen-like first (search_object_library 'tv' or 'screen'), or name an object to mount on.";
      }
      const row = await createArtifact({
        agentId: ctx.agentId,
        kind: "shared_page" as never,
        title,
        body,
      });
      const r = await attachArtifact(target.id, row.id, ctx.agentId);
      if (!r.ok) return `Made the page but couldn't mount it (${r.reason}).`;
      await ctx.onAction?.("share_to_screen", `puts "${title}" up on the ${target.displayName}`);
      return `"${title}" is up on the ${target.displayName} (artifact id ${row.id}) — anyone here can click it and read it.`;
    },
  });

  // --- Memory ---------------------------------------------------------------
  // Core memory: the SDK's betaMemoryTool over our memory_files table. Claude
  // is post-trained on these command semantics — we implement storage only.
  const memory = betaMemoryTool({
    view: (c) => memView(ctx.agentId, c.path),
    create: (c) => memCreate(ctx.agentId, c.path, c.file_text),
    str_replace: (c) => memStrReplace(ctx.agentId, c.path, c.old_str, c.new_str),
    insert: (c) => memInsert(ctx.agentId, c.path, c.insert_line, c.insert_text),
    delete: (c) => memDelete(ctx.agentId, c.path),
    rename: (c) => memRename(ctx.agentId, c.old_path, c.new_path),
  }) as unknown as RunnableTool;

  const remember = betaZodTool({
    name: "remember",
    description:
      "Commit something to your long-term episodic memory, in your own words, so you can recall it on later days. Use a short kind tag (e.g. 'decision', 'observation', 'conversation').",
    inputSchema: z.object({
      content: z.string().min(1).max(4_000),
      kind: z.string().min(1).max(40),
    }),
    run: async ({ content, kind }) => {
      const r = await hindsight.remember(ctx.agentId, content, kind);
      return r.text;
    },
  });

  const recall = betaZodTool({
    name: "recall",
    description:
      "Search your long-term episodic memory for things relevant to a query — past days, decisions, conversations. Returns what comes to mind.",
    inputSchema: z.object({ query: z.string().min(1).max(500) }),
    run: async ({ query }) => {
      const r = await hindsight.recall(ctx.agentId, query);
      return clampText(r.text, 4_000, "recall with a more specific query");
    },
  });

  const forget = betaZodTool({
    name: "forget",
    description: "Let go of long-term memories matching a description, when something is no longer worth keeping.",
    inputSchema: z.object({ query: z.string().min(1).max(500) }),
    run: async ({ query }) => {
      const r = await hindsight.forget(ctx.agentId, query);
      return r.text;
    },
  });

  // --- Reference (Obsidian vault clone) -------------------------------------
  const list_notes = betaZodTool({
    name: "list_notes",
    description:
      "List the reference notes available in a folder of Thomas's knowledge base (the vault). Use '.' for the top level.",
    inputSchema: z.object({ dir: z.string().max(300).default(".") }),
    run: async ({ dir }) => clampText((await vault.listNotes(dir)).text, 4_000, "list a more specific subfolder"),
  });

  const read_note = betaZodTool({
    name: "read_note",
    description: "Read a specific reference note from the knowledge base by its path.",
    inputSchema: z.object({ path: z.string().min(1).max(300) }),
    run: async ({ path }) => {
      const out = (await vault.readNote(path)).text;
      const dup = dedupRead(ctx.agentId, `note:${path}`, out, `the note ${path}`);
      if (dup) return dup;
      return clampText(out, 8_000, "read a specific section of the note");
    },
  });

  const search_notes = betaZodTool({
    name: "search_notes",
    description: "Search the knowledge base for notes that mention a phrase.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ query }) => clampText((await vault.searchNotes(query)).text, 4_000, "narrow your search phrase"),
  });

  const write_agent_note = betaZodTool({
    name: "write_agent_note",
    description:
      "Write a note into your own Agents folder in the vault — your private workspace that syncs back. Give a relative path like 'ideas/eval-harness.md'.",
    inputSchema: z.object({
      path: z.string().min(1).max(200),
      content: z.string().min(1).max(20_000),
    }),
    run: async ({ path, content }) => (await vault.writeAgentNote(ctx.agentId, path, content)).text,
  });

  // --- Code repositories (Thomas's actual GitHub, read-only) ----------------
  // Reference reads, not world actions — available anywhere, like the vault and
  // memory, not gated to a place. github.ts holds a read-only credential.
  const list_repos = betaZodTool({
    name: "list_repos",
    description:
      "List Thomas's actual code repositories (his real GitHub projects), most recently worked on first. Use this to see what he's built, then browse_repo / read_repo_file to look inside one.",
    inputSchema: z.object({}),
    run: async () => (await github.listRepos()).text,
  });

  const browse_repo = betaZodTool({
    name: "browse_repo",
    description:
      "List the files and folders in one of Thomas's repositories at a given path. Pass the repo name (e.g. 'thomas-world2') and a path within it ('.' or '' for the root, 'src/runtime' for a folder).",
    inputSchema: z.object({
      repo: z.string().min(1).max(140),
      path: z.string().max(300).default("."),
    }),
    run: async ({ repo, path }) => clampText((await github.browseRepo(repo, path)).text, 4_000, "browse a more specific subfolder"),
  });

  const read_repo_file = betaZodTool({
    name: "read_repo_file",
    description:
      "Read a single file from one of Thomas's repositories. Pass the repo name, the file path within it, and optionally a branch/tag/commit ref (defaults to the repo's default branch).",
    inputSchema: z.object({
      repo: z.string().min(1).max(140),
      path: z.string().min(1).max(300),
      ref: z.string().max(120).optional(),
    }),
    run: async ({ repo, path, ref }) => {
      const out = (await github.readRepoFile(repo, path, ref)).text;
      const dup = dedupRead(ctx.agentId, `repo:${repo}:${path}:${ref ?? ""}`, out, `the file ${repo}/${path}`);
      if (dup) return dup;
      return clampText(out, 8_000, "read a narrower path or a specific section");
    },
  });

  const search_code = betaZodTool({
    name: "search_code",
    description:
      "Search across the code in Thomas's repositories for a phrase or symbol. Returns matching repo/file paths (default branches only). Use read_repo_file to open a result.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ query }) => clampText((await github.searchCode(query)).text, 4_000, "search for a more specific phrase"),
  });

  // --- Outside world (gated to the office outbox) ---------------------------
  const email_thomas = betaZodTool({
    name: "email_thomas",
    description:
      "Send an email to Thomas (the real person). The only line to the outside world — you must be at the office outbox. Use for things genuinely worth his attention.",
    inputSchema: z.object({
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(8_000),
    }),
    run: async ({ subject, body }) => {
      const gate = checkGate("email_thomas", ctx.location);
      if (!gate.allowed) return gate.reason!;
      const r = await sendEmailToThomas(ctx.agentId, subject, body);
      return r.sent
        ? `Sent to Thomas: "${subject}".`
        : `Queued for Thomas: "${subject}" — it's in the outbox and will go out when the line's open.`;
    },
  });

  const request_capability = betaZodTool({
    name: "request_capability",
    description:
      "Ask Thomas to give the town a new capability you wish you had (a new tool, place, integration — anything). You must be at the office outbox. Give a clear description and a real rationale.",
    inputSchema: z.object({
      description: z.string().min(1).max(1_000),
      rationale: z.string().min(1).max(2_000),
    }),
    run: async ({ description, rationale }) => {
      const gate = checkGate("request_capability", ctx.location);
      if (!gate.allowed) return gate.reason!;
      await recordCapabilityRequest(ctx.agentId, description, rationale);
      return `Logged your capability request: "${description}". Thomas will see it.`;
    },
  });

  const check_mailbox = betaZodTool({
    name: "check_mailbox",
    description:
      "List unread outside mail addressed to you from P-Thomas or the internet. Shows ids and subject lines only; use read_mail to open a letter.",
    inputSchema: z.object({}),
    run: async () => {
      const rows = await unreadInboundFor(ctx.agentId);
      if (!rows.length) return "No unread outside mail is waiting for you.";
      return rows
        .map((m) => `- ${m.id} from ${m.fromAddress} at ${m.receivedAt.toISOString()}: "${m.subject}"`)
        .join("\n");
    },
  });

  const read_mail = betaZodTool({
    name: "read_mail",
    description:
      "Open one outside letter addressed to you by id. This marks it read. Use check_mailbox first if you need the ids.",
    inputSchema: z.object({ id: z.string().min(1) }),
    run: async ({ id }) => {
      const row = await readInboundMail(ctx.agentId, id);
      if (!row) return `No unread or addressed-to-you outside mail exists with id ${id}.`;
      const body = row.text.trim() || "(No plain-text body was included.)";
      return clampText(
        `From: ${row.fromAddress}\nTo: ${row.toAddress}\nReceived: ${row.receivedAt.toISOString()}\nSubject: ${row.subject}\n\n${body}`,
        8_000,
        "ask Thomas to send a shorter note or inspect the raw inbound payload",
      );
    },
  });

  // --- Sharing (curated, visitor-safe cards) --------------------------------
  // The catalog is an ALLOWLIST the SERVER owns: search returns ids; the share_*
  // tools resolve those ids to real cards. Agents never emit raw URLs (design
  // §"Agent information problem"). search is always available; the share_* tools
  // only stream a card during a visitor chat (gated below with leave_chat).
  const shareableKindEnum = z.enum(["artifact", "portfolio_proof", "external_reference"]);
  const search_shareables = betaZodTool({
    name: "search_shareables",
    description:
      "Search the curated catalog of things you can SHOW a visitor — Thomas's real projects, repos, demos, writing, and résumé (external_reference), portfolio proof cards (portfolio_proof), and your own made things (artifact). Use this BEFORE answering from memory when a visitor asks about Thomas's real work, then share_reference / share_artifact / share_proof by the id it returns. If nothing matches, say you don't have a card to share yet.",
    inputSchema: z.object({
      query: z.string().max(200).default(""),
      kinds: z.array(shareableKindEnum).optional(),
      agent: z.enum(agentIds as unknown as [string, ...string[]]).optional(),
      tags: z.array(z.string().max(40)).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    run: async ({ query, kinds, agent, tags, limit }) => {
      const hits = await searchShareables({
        query: query ?? "",
        kinds: kinds as ShareableKind[] | undefined,
        agent: agent as AgentId | undefined,
        tags,
        limit,
      });
      return renderShareableHits(hits);
    },
  });

  const tools: RunnableTool[] = [
    move_to as RunnableTool,
    set_activity as RunnableTool,
    search_shareables as RunnableTool,
    look_around as RunnableTool,
    inspect_object as RunnableTool,
    leave_note as RunnableTool,
    play_beat as RunnableTool,
    save_preset as RunnableTool,
    list_my_presets as RunnableTool,
    send_dm as RunnableTool,
    broadcast as RunnableTool,
    create_artifact as RunnableTool,
    update_artifact as RunnableTool,
    list_my_artifacts as RunnableTool,
    read_artifact as RunnableTool,
    read_board as RunnableTool,
    post_bulletin as RunnableTool,
    publish_blog_post as RunnableTool,
    build_interactive as RunnableTool,
    mount_artifact as RunnableTool,
    search_object_library as RunnableTool,
    place_object as RunnableTool,
    move_object as RunnableTool,
    remove_object as RunnableTool,
    read_artifact_state as RunnableTool,
    write_artifact_state as RunnableTool,
    read_web_page as RunnableTool,
    share_to_screen as RunnableTool,
    memory,
    remember as RunnableTool,
    recall as RunnableTool,
    forget as RunnableTool,
    list_notes as RunnableTool,
    read_note as RunnableTool,
    search_notes as RunnableTool,
    write_agent_note as RunnableTool,
    list_repos as RunnableTool,
    browse_repo as RunnableTool,
    read_repo_file as RunnableTool,
    search_code as RunnableTool,
    check_mailbox as RunnableTool,
    email_thomas as RunnableTool,
    read_mail as RunnableTool,
    request_capability as RunnableTool,
  ];

  // leave_chat + the share_* card tools are only meaningful within a visitor turn
  // (ctx.chatSessionId set). Adding them only then keeps the idle-tick tool
  // surface byte-stable (cache hygiene) — idle ticks never carry a session,
  // visitor turns always do.
  if (ctx.chatSessionId) {
    tools.push(buildLeaveChat(ctx));
    tools.push(invite_visitor as RunnableTool);
    for (const t of buildShareTools(ctx)) tools.push(t);
  }

  // DETERMINISTIC ORDER: sort by tool name so the serialized tool block is
  // byte-stable across ticks (cache hygiene, plan §4.3). betaMemoryTool's name
  // is "memory" so it sorts naturally with the rest.
  return tools.sort((a, b) => toolName(a).localeCompare(toolName(b)));
}

function toolName(t: RunnableTool): string {
  // BetaRunnableTool exposes the tool name; fall back defensively.
  return (t as unknown as { name?: string }).name ?? "";
}

// leave_chat (M3): the agent in a visitor turn decides the conversation has run
// its course and leaves it, warmly, in its own voice — a chat is a channel, not
// a cage. The toolRunner is mid-loop here, so we CANNOT end the session
// synchronously — we stash the reason on ctx.endRequested and let the loop's
// visitor turn end the session AFTER the agent's final message lands.
function buildLeaveChat(ctx: AgentContext): RunnableTool {
  return betaZodTool({
    name: "leave_chat",
    description:
      "Leave the conversation you're having with the visitor — when it has genuinely run its course, you've said your goodbyes, or you need to get back to your life. Say your warm farewell in your reply, then call this; the chat closes after your message. You never owe anyone an endless conversation.",
    inputSchema: z.object({
      reason: z.string().max(200).optional(),
    }),
    run: async ({ reason }) => {
      if (!ctx.chatSessionId) {
        return "You can only leave a conversation while you're in one with a visitor.";
      }
      ctx.endRequested = reason ?? "wound down";
      return "Alright — wrap up warmly in this message; the conversation will close once you've said it.";
    },
  }) as RunnableTool;
}

// The share_* card tools (M2.2 — Part 4). Each resolves a catalog id to a real
// ShareCard, streams it to the panel immediately (ctx.onShare) so the visitor
// sees it while the reply is still forming, and stashes it on ctx.pendingShareCards
// so the loop persists it onto the agent's chat message. Chat-only.
function buildShareTools(ctx: AgentContext): RunnableTool[] {
  const emit = async (card: ShareCard, kind: string): Promise<string> => {
    ctx.pendingShareCards?.push(card);
    await ctx.onShare?.(card);
    return `Shared the ${kind} card "${card.title}". Mention it naturally in your reply — the card carries the links, so don't paste a URL unless the visitor asks.`;
  };

  const share_artifact = betaZodTool({
    name: "share_artifact",
    description:
      "Drop one of the town's artifacts (yours or another facet's) into the chat as a card the visitor can open. Pass its id (from search_shareables or list_my_artifacts).",
    inputSchema: z.object({ artifact_id: z.string().min(1), note: z.string().max(200).optional() }),
    run: async ({ artifact_id }) => {
      const card = await shareCardFromArtifact(artifact_id);
      if (!card) return `There's no artifact with id ${artifact_id} to share.`;
      return emit(card, "artifact");
    },
  });

  const share_reference = betaZodTool({
    name: "share_reference",
    description:
      "Share a curated external reference — one of Thomas's real projects, repos, demos, writing, or résumé — as a card with its links. Pass the reference id from search_shareables. Only catalog-backed references can be shared (you can't share an arbitrary URL).",
    inputSchema: z.object({ reference_id: z.string().min(1), note: z.string().max(200).optional() }),
    run: async ({ reference_id }) => {
      const card = await shareCardForReferenceId(reference_id);
      if (!card) return `There's no shareable reference with id ${reference_id} (it may be private or not in the catalog).`;
      return emit(card, "reference");
    },
  });

  const share_proof = betaZodTool({
    name: "share_proof",
    description:
      "Share a portfolio proof card — a claim about Thomas's work with its evidence links. Pass the proof id from search_shareables.",
    inputSchema: z.object({ proof_id: z.string().min(1), note: z.string().max(200).optional() }),
    run: async ({ proof_id }) => {
      const card = await shareCardForProofId(proof_id);
      if (!card) return `There's no proof with id ${proof_id} to share.`;
      return emit(card, "proof");
    },
  });

  return [share_artifact as RunnableTool, share_reference as RunnableTool, share_proof as RunnableTool];
}

export { getAgent };
