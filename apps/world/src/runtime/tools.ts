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

import { moveAgent, setActivity, getAgent, setEngagement } from "../engine/agents.js";
import { checkGate, isAdjacent, getLocation, agentsAtLocation } from "../engine/locations.js";
import { appendEvent } from "../engine/events.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { tryAcquire } from "./agent-lock.js";
import { sendMessage } from "../engine/messages.js";
import { createArtifact, updateArtifact, getArtifact, recentArtifactsBy } from "../engine/artifacts.js";
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
import * as github from "./github.js";
import { checkFixtureAction, tryRecordEffect, type FixtureDef } from "./fixtures.js";

// Mutable per-tick context. `location` is read live from the row by the engine,
// but we cache the start-of-tick location and let move_to update it so a tick
// that walks somewhere and then uses a gated tool there works in one round.
export interface AgentContext {
  agentId: AgentId;
  location: LocationId;
  // The visitor chat session this agent is replying in, when applicable (design
  // doc §3.3). Set on chat-turn contexts so invite_to_chat knows which session
  // to add the invited agent to. Null on idle ticks.
  chatSessionId?: string | null;
  // Set by the leave_chat tool when the agent decides a chat has run its course.
  // The toolRunner is mid-loop when leave_chat fires, so it cannot end the
  // session synchronously; it stashes the reason here and the chat layer
  // (streamAgentTurn → runChatTurn) ends the session AFTER the final message.
  endRequested?: string;
  // Chat-only narration channel: tools call this AT THE POINT OF SUCCESS so the
  // panel's inline `action` frames can never describe a refused action (the old
  // tool_use-block scan narrated "walks to the office" even when move_to had
  // declined the hop — observed live). Undefined on idle ticks.
  onAction?: (tool: string, detail: string) => void | Promise<void>;
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
      "Walk to another location: town, office, library, workshop, cafe, park. If it's across town you'll cut through the town square on the way. Updates where you are for the rest of this tick.",
    inputSchema: z.object({
      location: z.enum(locationIds as unknown as [string, ...string[]]),
    }),
    run: async ({ location }) => {
      const to = location as LocationId;
      if (to === ctx.location) return `You're already at the ${to}.`;
      const adjacent = await isAdjacent(ctx.location, to);
      if (!adjacent) {
        // Hub-and-spoke: every place connects through town, so a cross-town
        // walk is two hops. Just do both — refusing stranded agents on a
        // topology detail no human would trip on (and mid-chat, the refusal
        // read as "the move is broken" to both the agent and the visitor).
        await moveAgent(ctx.agentId, "town");
        ctx.location = "town";
      }
      await moveAgent(ctx.agentId, to);
      ctx.location = to; // gated tools later this tick see the new place
      const loc = await getLocation(to);
      const name = loc?.name ?? to;
      await ctx.onAction?.(
        "move_to",
        adjacent ? `walks over to the ${name}` : `cuts through the town square to the ${name}`,
      );
      return `You walk to the ${name}. ${loc?.description ?? ""}`;
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
      const [loc, here] = await Promise.all([
        getLocation(ctx.location),
        agentsAtLocation(ctx.location, ctx.agentId),
      ]);
      const fixtures = ((loc?.fixtures as Array<{ id: string }>) ?? []).map((f) => f.id).join(", ");
      const others = here.length ? here.map((a) => a.displayName).join(", ") : "no one else";
      return `You're at the ${loc?.name ?? ctx.location}. ${loc?.description ?? ""}\nFixtures: ${fixtures || "(none)"}.\nAlso here: ${others}.`;
    },
  });

  const use_fixture = betaZodTool({
    name: "use_fixture",
    description:
      "Do something physical with a fixture where you are — make the set react. e.g. ring the office phone, hiss the cafe espresso machine, flicker a lamp, rustle the town notice board. You can only act on a fixture that's HERE with you and only in ways it allows. Others and any visitors here will notice. Use sparingly — it's a flourish, not a fidget.",
    inputSchema: z.object({
      fixture: z.string().min(1).max(60),
      action: z.string().min(1).max(40),
      note: z.string().max(200).optional(),
    }),
    run: async ({ fixture, action }) => {
      const loc = await getLocation(ctx.location);
      const fixtures = ((loc?.fixtures as FixtureDef[]) ?? []);
      const check = checkFixtureAction(fixtures, fixture, action, loc?.name ?? ctx.location);
      if (!check.ok) return check.reason;
      // Rate limit AFTER validation so a wrong-place attempt doesn't burn a slot.
      if (!tryRecordEffect(ctx.agentId)) {
        return `You've been fussing with the ${fixture} a lot — better not overdo it. Give it a rest for a bit.`;
      }
      await appendEvent({
        type: "world.effect",
        agentId: ctx.agentId,
        locationId: ctx.location,
        visibility: "public",
        payload: { location: ctx.location, fixture, effect: action, agent: ctx.agentId },
      });
      await ctx.onAction?.("use_fixture", `${action}s the ${fixture}`);
      return `You ${action} the ${fixture}. It's noticeable to anyone here.`;
    },
  });

  // --- Social ----------------------------------------------------------------
  const say = betaZodTool({
    name: "say",
    description:
      "Say something out loud where you are. Saying something is HOW conversations happen here: co-located facets hear it and usually wake shortly to respond, and any visitors here see it too. Optionally address a specific facet with `to` — they'll know it was aimed at them. Use this for ambient remarks, opening a conversation, or replying to whoever's around.",
    inputSchema: z.object({
      text: z.string().min(1).max(600),
      // Optional addressing for emergent room talk aimed at a specific facet.
      to: z.enum(agentIds as unknown as [string, ...string[]]).optional(),
    }),
    run: async ({ text, to }) => {
      const addressed = (to as AgentId | undefined) ?? undefined;
      if (addressed === ctx.agentId) {
        return "You can't address yourself — leave `to` off to speak to the room.";
      }
      await appendEvent({
        type: "agent.spoke",
        agentId: ctx.agentId,
        locationId: ctx.location,
        visibility: "location",
        payload: {
          agent: ctx.agentId,
          location: ctx.location,
          text,
          ...(addressed ? { to: addressed } : {}),
        },
      });
      await ctx.onAction?.("say", `says to the room: "${text}"`);
      return addressed ? `You said to ${addressed}: "${text}"` : `You said: "${text}"`;
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
    run: async ({ repo, path }) => (await github.browseRepo(repo, path)).text,
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
    run: async ({ repo, path, ref }) => (await github.readRepoFile(repo, path, ref)).text,
  });

  const search_code = betaZodTool({
    name: "search_code",
    description:
      "Search across the code in Thomas's repositories for a phrase or symbol. Returns matching repo/file paths (default branches only). Use read_repo_file to open a result.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    run: async ({ query }) => (await github.searchCode(query)).text,
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
    use_fixture as RunnableTool,
    say as RunnableTool,
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
    list_repos as RunnableTool,
    browse_repo as RunnableTool,
    read_repo_file as RunnableTool,
    search_code as RunnableTool,
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

// invite_to_chat (design doc §3.3b): an agent in a visitor chat invites a SECOND
// agent into the session. Gate (TOCTOU-safe): the target is co-located OR one
// move away (they walk — emit agent.moved) AND tryAcquire(target) succeeds AND
// the target is unengaged — all atomic. Success → add to participant_agent_ids,
// set the target's engagement to this chat, emit chat.joined, in-fiction
// confirmation. Failure → in-fiction reason. Hard cap 2 agents + 1 visitor.
function buildInviteToChat(ctx: AgentContext): RunnableTool {
  const { agents, chatSessions } = schema;
  return betaZodTool({
    name: "invite_to_chat",
    description:
      "Invite another facet to join the conversation you're having with the visitor right now. They must be here with you or one step away (they'll walk over). Use this to bring in someone whose perspective the visitor would value.",
    inputSchema: z.object({
      agent: z.enum(agentIds as unknown as [string, ...string[]]),
    }),
    run: async ({ agent }) => {
      const target = agent as AgentId;
      const sessionId = ctx.chatSessionId;
      if (!sessionId) return "You can only invite someone while you're in a conversation with a visitor.";
      if (target === ctx.agentId) return "You're already here.";

      const [session, here] = await Promise.all([
        db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).then((r) => r[0]),
        agentsAtLocation(ctx.location),
      ]);
      if (!session || session.endedAt) return "That conversation has already wrapped up.";
      const roster = ((session.participantAgentIds as AgentId[] | null) ?? []).filter(Boolean);
      const current = roster.length ? roster : [session.agentId as AgentId];
      if (current.includes(target)) return `${target} is already part of this conversation.`;
      // Hard cap: 2 agents + 1 visitor.
      if (current.length >= 2) {
        return "There's already two of you here with the visitor — any more would be a crowd.";
      }

      const targetRow = await getAgent(target);
      if (!targetRow) return `You don't know anyone called ${target}.`;

      // Co-location or one-move-away gate. If co-located, no walk. If adjacent,
      // they walk over (emit agent.moved via moveAgent). Otherwise refuse.
      const coLocated = here.some((a) => a.id === target);
      const targetLoc = targetRow.locationId as LocationId;
      let walked = false;
      if (!coLocated) {
        const adjacent = await isAdjacent(targetLoc, ctx.location);
        if (!adjacent) {
          return `${target} is too far away to join right now — they'd have a long way to walk.`;
        }
        walked = true;
      }

      // Atomic acquire: take the target's lock + check unengaged together, so a
      // racing tick/chat can't slip the target into another engagement between
      // the check and the set (the TOCTOU the boolean never closed).
      const release = tryAcquire(target);
      if (!release) return `${target} is mid-thought right now — try again in a moment.`;
      try {
        const fresh = await getAgent(target);
        if (!fresh || fresh.engagement) {
          return `${target} is already caught up in something else.`;
        }
        // Walk them over first (emits agent.moved) so the town renders the move.
        if (walked) await moveAgent(target, ctx.location);
        // Add to the roster + engage the target in THIS chat session. The two
        // existing participants keep their engagement; setEngagement on the full
        // roster re-stamps everyone to the same {kind:'chat', id} cleanly.
        const nextRoster = [...current, target];
        await db
          .update(chatSessions)
          .set({ participantAgentIds: nextRoster })
          .where(eq(chatSessions.id, sessionId));
        await setEngagement("chat", sessionId, nextRoster);
        await appendEvent({
          type: "chat.joined",
          agentId: target,
          // Presence only — NO sessionId (design doc §5: chat content is private;
          // the event carries presence). Visibility stays 'location' so co-located
          // perception + feed still materialize the walk-over without leaking the
          // session id to all surfaces.
          visibility: "location",
          payload: { agent: target },
        });
        return `${target} ${walked ? "walks over and joins" : "joins"} the conversation.`;
      } finally {
        release();
      }
    },
  }) as RunnableTool;
}

// leave_chat (M2.1 full-agency chat): an agent in a visitor chat decides the
// conversation has run its course and leaves it, warmly, in its own voice. A
// chat is a channel, not a cage. The toolRunner is mid-loop here, so we CANNOT
// end the session synchronously — we stash the reason on ctx.endRequested and
// let the chat layer end the whole session AFTER the agent's final message
// lands. v1 semantics: leaving ends the WHOLE session (solo or group).
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

// The chat subset (plan §4.1; widened in M2.1 to full agency). A chat is a
// channel, not a cage: the agent keeps its whole life mid-chat — it can walk
// somewhere, make or revise an artifact, speak to the room, check its memory.
// The only EXCLUSIONS are the external / megaphone side effects (email_thomas,
// request_capability, broadcast, post_bulletin, publish_blog_post) — those stay
// tick-only. Group chat (design doc §3.3) adds invite_to_chat, and M2.1 adds
// leave_chat, both whenever a chat session is set.
export function buildChatTools(ctx: AgentContext): RunnableTool[] {
  const allowed = new Set([
    "move_to",
    "set_activity",
    "look_around",
    "use_fixture",
    "say",
    "create_artifact",
    "update_artifact",
    "memory",
    "remember",
    "recall",
    "forget",
    "send_dm",
    "list_notes",
    "read_note",
    "search_notes",
    "write_agent_note",
    "list_repos",
    "browse_repo",
    "read_repo_file",
    "search_code",
  ]);
  const tools = buildTools(ctx).filter((t) => allowed.has(toolName(t)));
  // invite_to_chat + leave_chat are only meaningful within a visitor chat session.
  if (ctx.chatSessionId) {
    tools.push(buildInviteToChat(ctx));
    tools.push(buildLeaveChat(ctx));
  }
  // Keep the byte-stable sorted order (cache hygiene) now that we appended.
  return tools.sort((a, b) => toolName(a).localeCompare(toolName(b)));
}

export { getAgent };
