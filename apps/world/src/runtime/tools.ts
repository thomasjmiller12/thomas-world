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
import { agentIds, locationIds, artifactKinds, type AgentId, type LocationId } from "@town/contract";

import { moveAgent, setActivity, getAgent } from "../engine/agents.js";
import { checkGate, isAdjacent, getLocation, agentsAtLocation } from "../engine/locations.js";
import { appendEvent } from "../engine/events.js";
import { sendMessage } from "../engine/messages.js";
import { createArtifact, updateArtifact, getArtifact } from "../engine/artifacts.js";
import { recordCapabilityRequest, sendEmailToThomas } from "../engine/outside.js";
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

// Mutable per-tick context. `location` is read live from the row by the engine,
// but we cache the start-of-tick location and let move_to update it so a tick
// that walks somewhere and then uses a gated tool there works in one round.
export interface AgentContext {
  agentId: AgentId;
  location: LocationId;
  // Conversation the agent is currently in (set by start_conversation), so
  // reply/end_conversation know which scene to write to.
  conversationId: string | null;
}

// Tools the idle tick gets. The chat subset (plan §4.1) is a filtered view.
export type RunnableTool = BetaRunnableTool<unknown>;

const artifactKindEnum = z.enum(artifactKinds as unknown as [string, ...string[]]);

// Build the full tool array for one tick, bound to `ctx`.
export function buildTools(ctx: AgentContext): RunnableTool[] {
  // --- World -----------------------------------------------------------------
  const move_to = betaZodTool({
    name: "move_to",
    description:
      "Walk to an adjacent location. Locations: town, office, library, workshop, cafe, park. You must be adjacent (everything connects through town). Updates where you are for the rest of this tick.",
    inputSchema: z.object({
      location: z.enum(locationIds as unknown as [string, ...string[]]),
    }),
    run: async ({ location }) => {
      const to = location as LocationId;
      if (to === ctx.location) return `You're already at the ${to}.`;
      const adjacent = await isAdjacent(ctx.location, to);
      if (!adjacent) {
        return `You can't get to the ${to} directly from the ${ctx.location} — most places connect through the town square.`;
      }
      await moveAgent(ctx.agentId, to);
      ctx.location = to; // gated tools later this tick see the new place
      const loc = await getLocation(to);
      return `You walk to the ${loc?.name ?? to}. ${loc?.description ?? ""}`;
    },
  });

  const set_activity = betaZodTool({
    name: "set_activity",
    description:
      "Set your current activity line — what you're visibly doing right now (e.g. 'drafting a post on eval design', 'reading a paper'). Others and visitors can see this.",
    inputSchema: z.object({ text: z.string().min(1).max(140) }),
    run: async ({ text }) => {
      await setActivity(ctx.agentId, text);
      return `Your activity is now: ${text}`;
    },
  });

  const look_around = betaZodTool({
    name: "look_around",
    description:
      "Take a closer look at where you are right now — the place, its fixtures, and who else is here.",
    inputSchema: z.object({}),
    run: async () => {
      const [loc, here] = await Promise.all([
        getLocation(ctx.location),
        agentsAtLocation(ctx.location, ctx.agentId),
      ]);
      const fixtures = ((loc?.fixtures as Array<{ id: string }>) ?? []).map((f) => f.id).join(", ");
      const others = here.length ? here.map((a) => a.displayName).join(", ") : "no one else";
      return `You're at the ${loc?.name ?? ctx.location}. ${loc?.description ?? ""}\nFixtures: ${fixtures || "(none)"}.\nAlso here: ${others}.`;
    },
  });

  // --- Social ----------------------------------------------------------------
  const say = betaZodTool({
    name: "say",
    description:
      "Say something out loud where you are. Co-located facets and any visitors here can hear it. Use this for ambient remarks and talking to whoever's around.",
    inputSchema: z.object({ text: z.string().min(1).max(600) }),
    run: async ({ text }) => {
      await appendEvent({
        type: "agent.spoke",
        agentId: ctx.agentId,
        locationId: ctx.location,
        visibility: "location",
        payload: { agent: ctx.agentId, location: ctx.location, text },
      });
      return `You said: "${text}"`;
    },
  });

  const start_conversation = betaZodTool({
    name: "start_conversation",
    description:
      "Start a face-to-face conversation with another facet who is HERE with you. They must be co-located. After this you can use reply to continue and end_conversation to wrap up.",
    inputSchema: z.object({
      agent: z.enum(agentIds as unknown as [string, ...string[]]),
    }),
    run: async ({ agent }) => {
      const other = agent as AgentId;
      if (other === ctx.agentId) return "You can't start a conversation with yourself.";
      const here = await agentsAtLocation(ctx.location, ctx.agentId);
      if (!here.some((a) => a.id === other)) {
        return `${other} isn't here with you. You'd need to be in the same place — try moving to where they are, or DM them instead.`;
      }
      // The scheduler drives the actual bounded scene; here we just signal intent
      // by recording the opening. The scene runner picks it up.
      return `__START_CONVERSATION__:${other}`;
    },
  });

  const reply = betaZodTool({
    name: "reply",
    description:
      "Say your next line in the conversation you're currently in. Only valid while a conversation is open.",
    inputSchema: z.object({ text: z.string().min(1).max(600) }),
    run: async ({ text }) => {
      if (!ctx.conversationId) {
        return "You're not in a conversation right now. Start one with start_conversation, or use say to speak to the room.";
      }
      return `__REPLY__:${text}`;
    },
  });

  const end_conversation = betaZodTool({
    name: "end_conversation",
    description: "Wrap up the conversation you're currently in.",
    inputSchema: z.object({}),
    run: async () => {
      if (!ctx.conversationId) return "You're not in a conversation.";
      return `__END_CONVERSATION__`;
    },
  });

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
      const row = await createArtifact({
        agentId: ctx.agentId,
        kind: kind as never,
        title,
        body,
      });
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
      return `Updated "${title ?? existing.title}".`;
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
      return r.text;
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
    run: async ({ dir }) => (await vault.listNotes(dir)).text,
  });

  const read_note = betaZodTool({
    name: "read_note",
    description: "Read a specific reference note from the knowledge base by its path.",
    inputSchema: z.object({ path: z.string().min(1).max(300) }),
    run: async ({ path }) => (await vault.readNote(path)).text,
  });

  const search_notes = betaZodTool({
    name: "search_notes",
    description: "Search the knowledge base for notes that mention a phrase.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ query }) => (await vault.searchNotes(query)).text,
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

  const tools: RunnableTool[] = [
    move_to as RunnableTool,
    set_activity as RunnableTool,
    look_around as RunnableTool,
    say as RunnableTool,
    start_conversation as RunnableTool,
    reply as RunnableTool,
    end_conversation as RunnableTool,
    send_dm as RunnableTool,
    broadcast as RunnableTool,
    create_artifact as RunnableTool,
    update_artifact as RunnableTool,
    post_bulletin as RunnableTool,
    publish_blog_post as RunnableTool,
    memory,
    remember as RunnableTool,
    recall as RunnableTool,
    forget as RunnableTool,
    list_notes as RunnableTool,
    read_note as RunnableTool,
    search_notes as RunnableTool,
    write_agent_note as RunnableTool,
    email_thomas as RunnableTool,
    request_capability as RunnableTool,
  ];

  // DETERMINISTIC ORDER: sort by tool name so the serialized tool block is
  // byte-stable across ticks (cache hygiene, plan §4.3). betaMemoryTool's name
  // is "memory" so it sorts naturally with the rest.
  return tools.sort((a, b) => toolName(a).localeCompare(toolName(b)));
}

function toolName(t: RunnableTool): string {
  // BetaRunnableTool exposes the tool name; fall back defensively.
  return (t as unknown as { name?: string }).name ?? "";
}

// The chat subset (plan §4.1): visitor chat runs on Opus with a smaller, safe
// toolset — no world-mutating "making" tools, no email/capability, but memory
// recall and look_around so the agent stays grounded and can reference its life.
export function buildChatTools(ctx: AgentContext): RunnableTool[] {
  const allowed = new Set([
    "look_around",
    "recall",
    "memory",
    "send_dm",
  ]);
  return buildTools(ctx).filter((t) => allowed.has(toolName(t)));
}

export { getAgent };
