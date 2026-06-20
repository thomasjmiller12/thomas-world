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
import { agentIds, locationIds, artifactKinds, type AgentId, type LocationId, type ShareCard } from "@town/contract";

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
      return `"${a.title}" — a ${a.kind} by ${a.agentId}${a.published ? " (published)" : ""}\n\n${a.body}`;
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
    use_fixture as RunnableTool,
    send_dm as RunnableTool,
    broadcast as RunnableTool,
    create_artifact as RunnableTool,
    update_artifact as RunnableTool,
    list_my_artifacts as RunnableTool,
    read_artifact as RunnableTool,
    read_board as RunnableTool,
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

  // leave_chat + the share_* card tools are only meaningful within a visitor turn
  // (ctx.chatSessionId set). Adding them only then keeps the idle-tick tool
  // surface byte-stable (cache hygiene) — idle ticks never carry a session,
  // visitor turns always do.
  if (ctx.chatSessionId) {
    tools.push(buildLeaveChat(ctx));
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
