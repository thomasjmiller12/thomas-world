// Hono HTTP layer (plan §5). All read endpoints derive from the event log /
// engine helpers; the only writes here are visitor registration and the chat
// stubs the runtime phase fills in. SSE drives the live frontend.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { AgentId, ArtifactKind, MessageScope } from "@town/contract";
import {
  agentIds,
  locationIds,
  artifactKinds,
  HealthResponse,
  SnapshotResponse,
  EventsResponse,
  FeedResponse,
  AgentProfileResponse,
  MessagesResponse,
  CreateVisitorResponse,
  GetVisitorResponse,
  PatchVisitorRequest,
  CreateChatResponse,
  GetChatResponse,
  JoinConversationResponse,
} from "@town/contract";
import type { ArtifactSummary } from "@town/contract";
import type { z } from "zod";
import { config } from "../config.js";
import { buildSnapshot, engagementToContract } from "../engine/snapshot.js";
import {
  eventsAfter,
  recentEventsForAgent,
  publicView,
} from "../engine/events.js";
import { getFeed } from "../engine/feed.js";
import { getAgent, allAgents } from "../engine/agents.js";
import { listMessages } from "../engine/messages.js";
import {
  listArtifacts,
  getArtifact,
} from "../engine/artifacts.js";
import {
  registerVisitor,
  visitorArrived,
  visitorLeft,
  touchVisitor,
  getVisitor,
  visitorTokenValid,
  moveVisitor,
  renameVisitor,
} from "../engine/visitors.js";
import { agentsAtLocation } from "../engine/locations.js";
import { boostAgent } from "../runtime/scheduler.js";
import { subscribe } from "../engine/bus.js";
import { spendTodayUsd, isBudgetExhausted } from "../engine/usage.js";
import { renderDebugPage } from "./debug.js";
import { runTick } from "../runtime/tick.js";
import { hasLlm } from "../runtime/client.js";
import { flushTracing } from "../runtime/tracing.js";
import {
  openChat,
  endChat,
  runChatTurn,
  suggestedReplies,
  chatTokenValid,
  openGreeting,
  pingChat,
  getChatTranscript,
  chatHasAnyMessage,
  joinConversation,
} from "../runtime/chat.js";

const agentSet = new Set<string>(agentIds);
const locationSet = new Set<string>(locationIds);
const artifactKindSet = new Set<string>(artifactKinds);

function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && agentSet.has(v);
}

// Response validation (design doc §5): outside production, parse every JSON
// response through its contract schema before returning, so server↔contract
// drift becomes a thrown error rather than a silent fork. In production we skip
// the cost (and never 500 a real visitor over a drift the tests should catch).
function validated<T>(schema: z.ZodType<T>, value: T): T {
  if (config.nodeEnv !== "production") {
    const r = schema.safeParse(value);
    if (!r.success) {
      throw new Error(`contract response validation failed: ${r.error.message}`);
    }
    return r.data;
  }
  return value;
}

export function createApp() {
  const app = new Hono();

  app.use("*", cors());

  // --- health -------------------------------------------------------------
  // {ok, ts, llm, budgetExhausted} (design doc §5): llm = model provider
  // configured; budgetExhausted = today's spend met the global daily ceiling.
  app.get("/health", async (c) => {
    const budgetExhausted = await isBudgetExhausted();
    return c.json(
      validated(HealthResponse, {
        ok: true,
        ts: new Date().toISOString(),
        llm: hasLlm(),
        budgetExhausted,
      }),
    );
  });

  // --- GET /world/snapshot -------------------------------------------------
  app.get("/world/snapshot", async (c) => {
    return c.json(validated(SnapshotResponse, await buildSnapshot()));
  });

  // --- GET /events?after=<id> (polling/catch-up) --------------------------
  // publicView applied POST-fetch so pagination semantics survive (design §5).
  app.get("/events", async (c) => {
    const after = c.req.query("after");
    const events = publicView(await eventsAfter(after));
    return c.json(validated(EventsResponse, { events }));
  });

  // --- GET /events/stream (SSE; Last-Event-ID resume; 25s heartbeats) -----
  app.get("/events/stream", (c) => {
    // Optional visitor presence: ?visitorId=... ties arrival/departure to the
    // connection lifetime (plan §3.1).
    const visitorId = c.req.query("visitorId") ?? null;
    // Resume point: header (browser auto-reconnect) or ?lastEventId=.
    const lastEventId =
      c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? undefined;

    return streamSSE(c, async (stream) => {
      let presentVisitor: { id: string; name: string } | null = null;
      if (visitorId) {
        try {
          const v = await getVisitor(visitorId);
          if (v) {
            presentVisitor = { id: v.id, name: v.name };
            await touchVisitor(v.id);
            await visitorArrived(v.id, v.name); // perceivable world event
          }
        } catch (err) {
          console.warn("[sse] visitor arrival failed:", (err as Error).message);
        }
      }

      // Subscribe to the live bus BEFORE reading the backlog so any event
      // appended during the (paged) backlog read lands in the queue rather than
      // falling into the gap between "backlog SELECT" and "listener registered".
      // We dedupe the queue against the backlog high-water id before flushing.
      const queue: { id: string; type: string; raw: string }[] = [];
      let resolveWake: (() => void) | null = null;
      const wake = () => {
        if (resolveWake) {
          resolveWake();
          resolveWake = null;
        }
      };
      const unsub = subscribe((event) => {
        // Live-queue flush is one of the three publicView sites (design §5):
        // never push a private event onto a human-facing stream.
        if (event.visibility === "private") return;
        queue.push({ id: event.id, type: event.type, raw: JSON.stringify(event) });
        wake();
      });
      stream.onAbort(() => {
        unsub();
        wake();
      });

      // Catch-up replay from the durable log so no event is missed across a
      // reconnect — paged until exhausted (eventsAfter is capped per call) so a
      // client resuming after >cap missed events still gets all of them.
      let cursor = lastEventId;
      let backlogHigh = 0;
      try {
        for (;;) {
          const batch = await eventsAfter(cursor);
          if (batch.length === 0) break;
          // Backlog replay is one of the three publicView sites (design §5). We
          // advance the cursor/high-water by the RAW batch ids (so private
          // events don't cause a re-fetch loop) but only write public ones.
          for (const e of publicView(batch)) {
            await stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(e) });
          }
          backlogHigh = Math.max(backlogHigh, Number(batch[batch.length - 1].id));
          cursor = batch[batch.length - 1].id;
          if (batch.length < 200) break; // last (partial) page
        }
      } catch (err) {
        console.warn("[sse] backlog replay failed:", (err as Error).message);
      }

      let heartbeatAt = Date.now() + 25_000;
      try {
        while (!stream.aborted) {
          // Flush anything queued, skipping any live event already covered by the
          // backlog replay (id <= backlogHigh) so a reconnect never double-sends.
          while (queue.length && !stream.aborted) {
            const ev = queue.shift()!;
            if (Number(ev.id) <= backlogHigh) continue;
            await stream.writeSSE({ id: ev.id, event: ev.type, data: ev.raw });
          }
          if (stream.aborted) break;
          // Heartbeat every ~25s to keep proxies from closing the connection.
          const now = Date.now();
          if (now >= heartbeatAt) {
            await stream.writeSSE({ event: "heartbeat", data: String(now) });
            heartbeatAt = now + 25_000;
          }
          // Wait for either a new event or the heartbeat deadline. Clear the
          // timer on early wake so timers don't accumulate on a busy stream.
          const waitMs = Math.max(50, heartbeatAt - Date.now());
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            resolveWake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      } finally {
        unsub();
        if (presentVisitor) {
          try {
            await visitorLeft(presentVisitor.id); // departure perceivable
          } catch (err) {
            console.warn("[sse] visitor departure failed:", (err as Error).message);
          }
        }
      }
    });
  });

  // --- GET /feed?agent=&cursor= -------------------------------------------
  app.get("/feed", async (c) => {
    const agentParam = c.req.query("agent");
    const agent = isAgentId(agentParam) ? agentParam : undefined;
    const cursor = c.req.query("cursor");
    const { items, nextCursor, count } = await getFeed(agent, cursor);
    return c.json(validated(FeedResponse, { items, nextCursor, count }));
  });

  // --- GET /agents/:id -----------------------------------------------------
  app.get("/agents/:id", async (c) => {
    const id = c.req.param("id");
    if (!isAgentId(id)) return c.json({ error: "unknown agent" }, 404);
    const a = await getAgent(id);
    if (!a) return c.json({ error: "unknown agent" }, 404);
    const [artifactRows, recent] = await Promise.all([
      listArtifacts({ agent: id }, 10),
      recentEventsForAgent(id, 5),
    ]);
    return c.json(
      validated(AgentProfileResponse, {
        agent: {
          id: a.id,
          displayName: a.displayName,
          locationId: a.locationId,
          status: a.status,
          activity: a.activity ?? null,
          busy: a.engagement != null,
          engagement: engagementToContract(a.engagement),
          lastTickAt: a.lastTickAt ? a.lastTickAt.toISOString() : null,
        },
        recentArtifacts: artifactRows.map(toArtifactSummary),
        recentEvents: recent,
      }),
    );
  });

  // --- GET /messages?scope=broadcast|dm&cursor= ---------------------------
  app.get("/messages", async (c) => {
    const scopeParam = c.req.query("scope");
    const scope: MessageScope | undefined =
      scopeParam === "broadcast" || scopeParam === "dm" ? scopeParam : undefined;
    const cursor = c.req.query("cursor");
    const { rows, nextCursor } = await listMessages(scope, cursor);
    return c.json(
      validated(MessagesResponse, {
        messages: rows.map((m) => ({
          id: String(m.id),
          from: m.fromAgent as AgentId,
          to: (m.toAgent ?? null) as AgentId | null,
          body: m.body,
          ts: m.ts.toISOString(),
          readAt: m.readAt ? m.readAt.toISOString() : null,
        })),
        nextCursor,
      }),
    );
  });

  // --- GET /artifacts?kind=&agent=  and  GET /artifacts/:id ---------------
  app.get("/artifacts", async (c) => {
    const kindParam = c.req.query("kind");
    const agentParam = c.req.query("agent");
    const kind: ArtifactKind | undefined =
      kindParam && artifactKindSet.has(kindParam) ? (kindParam as ArtifactKind) : undefined;
    const agent = isAgentId(agentParam) ? agentParam : undefined;
    const rows = await listArtifacts({ kind, agent });
    return c.json({ artifacts: rows.map(toArtifactSummary) });
  });

  app.get("/artifacts/:id", async (c) => {
    const row = await getArtifact(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ artifact: toArtifact(row) });
  });

  // --- POST /visitors {name} ----------------------------------------------
  app.post("/visitors", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null;
    if (!name) return c.json({ error: "name required" }, 400);
    // Cap the display name — it's stored, broadcast to every SSE client, and fed
    // into agent observation packets (token-cost amplification otherwise).
    if (name.length > 80) return c.json({ error: "name too long" }, 400);
    const v = await registerVisitor(name);
    return c.json(
      validated(CreateVisitorResponse, {
        visitorId: v.id,
        name: v.name,
        visitorToken: v.visitorToken ?? "",
      }),
    );
  });

  // --- GET /visitors/:id (identity validation on boot) --------------------
  // WorldClient validates a stored visitorId here; re-registers on 404. The
  // token is NEVER echoed — it lives only in the browser that registered.
  app.get("/visitors/:id", async (c) => {
    const v = await getVisitor(c.req.param("id"));
    if (!v) return c.json({ error: "unknown visitor" }, 404);
    return c.json(
      validated(GetVisitorResponse, {
        visitorId: v.id,
        name: v.name,
        locationId: (v.locationId ?? null) as GetVisitorResponse["locationId"],
      }),
    );
  });

  // --- PATCH /visitors/:id {locationId?, name?} ---------------------------
  // Visitor-token authorized (design doc §2). A locationId change persists the
  // visitor's logical body, emits a public `visitor.moved {from,to}`, and pulls
  // unengaged agents at the destination forward (scheduler boost). A name change
  // renames the row. Both fields optional; at least one is expected.
  app.patch("/visitors/:id", async (c) => {
    const id = c.req.param("id");
    const v = await getVisitor(id);
    if (!v) return c.json({ error: "unknown visitor" }, 404);
    const token = c.req.header("x-visitor-token");
    if (!(await visitorTokenValid(id, token))) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const parsed = PatchVisitorRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { locationId, name } = parsed.data;
    if (locationId === undefined && name === undefined) {
      return c.json({ error: "locationId or name required" }, 400);
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) return c.json({ error: "name required" }, 400);
      if (trimmed.length > 80) return c.json({ error: "name too long" }, 400);
      await renameVisitor(id, trimmed);
    }

    if (locationId !== undefined) {
      const moved = await moveVisitor(id, locationId);
      // Co-located tick boost (design doc §2): when the visitor actually changed
      // rooms, pull unengaged agents AT THE DESTINATION forward so they can
      // acknowledge the arrival. boostAgent throttles per (visitor, agent) and
      // skips engaged agents itself, so we just fan out — best-effort, never
      // blocking the PATCH response on the scheduler.
      if (moved?.changed) {
        const here = await agentsAtLocation(locationId).catch(() => []);
        for (const a of here) {
          void boostAgent(a.id as AgentId, id).catch((err) =>
            console.warn(`[visitors] boost ${a.id} failed:`, (err as Error).message),
          );
        }
      }
    }

    await touchVisitor(id);
    const fresh = await getVisitor(id);
    return c.json(
      validated(GetVisitorResponse, {
        visitorId: id,
        name: fresh?.name ?? v.name,
        locationId: (fresh?.locationId ?? null) as GetVisitorResponse["locationId"],
      }),
    );
  });

  // --- POST /visitors/:id/interact {locationId, fixture} ------------------
  // Visitor-token authorized. Fixture interaction + visitor.interacted event
  // land in step D; A2 ships the auth gate + a 501 stub.
  app.post("/visitors/:id/interact", async (c) => {
    const id = c.req.param("id");
    const v = await getVisitor(id);
    if (!v) return c.json({ error: "unknown visitor" }, 404);
    const token = c.req.header("x-visitor-token");
    if (!(await visitorTokenValid(id, token))) return c.json({ error: "unauthorized" }, 401);
    return c.json({ error: "not implemented" }, 501);
  });

  // --- POST /chats {agentId, visitorId} -----------------------------------
  // Opens a chat session + returns the per-session token. An engaged agent → a
  // 409 carrying the in-fiction engagement (the client renders alternatives); a
  // locked agent (tick mid-flight) → a distinct 409 "mid-thought".
  app.post("/chats", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = body?.agentId;
    const visitorId = body?.visitorId;
    if (!isAgentId(agentId)) return c.json({ error: "unknown agent" }, 404);
    if (typeof visitorId !== "string" || !visitorId) {
      return c.json({ error: "visitorId required" }, 400);
    }
    const res = await openChat(agentId, visitorId);
    switch (res.status) {
      case "unknown":
        return c.json({ error: "unknown agent" }, 404);
      case "engaged":
        return c.json({ error: "engaged", reason: "engaged", engagement: res.engagement }, 409);
      case "mid-thought":
        return c.json({ error: "mid-thought", reason: "mid-thought" }, 409);
      case "ok":
        return c.json(
          validated(CreateChatResponse, {
            sessionId: res.sessionId,
            agentId: res.agentId,
            visitorId: res.visitorId,
            participants: res.participants,
            sessionToken: res.sessionToken,
          }),
        );
    }
  });

  // --- POST /conversations/:id/join {visitorId} ---------------------------
  // Visitor interjects into a live agent↔agent scene (design doc §3.3a). The
  // scene converts to a group chat with BOTH agents; the visitor's subsequent
  // messages flow through /chats/:id/messages with the returned sessionToken.
  // Visitor-token gated. Registry CAS: first visitor wins; a gone / already-
  // converted scene → 409 (the client degrades to listen-in).
  app.post("/conversations/:id/join", async (c) => {
    const conversationId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const visitorId = body?.visitorId;
    if (typeof visitorId !== "string" || !visitorId) {
      return c.json({ error: "visitorId required" }, 400);
    }
    const token = c.req.header("x-visitor-token");
    if (!(await visitorTokenValid(visitorId, token))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const res = await joinConversation(conversationId, visitorId);
    switch (res.status) {
      case "gone":
        return c.json({ error: "scene ended", reason: "gone" }, 409);
      case "converted":
        return c.json({ error: "already converted", reason: "converted" }, 409);
      case "ok":
        return c.json(
          validated(JoinConversationResponse, {
            sessionId: res.sessionId,
            agentId: res.agentId,
            visitorId: res.visitorId,
            participants: res.participants,
            sessionToken: res.sessionToken,
          }),
        );
    }
  });

  // --- POST /chats/:id/open → SSE greeting stream -------------------------
  // Token-gated. Streams the agent-initiated greeting as contract ChatStreamFrames
  // (design doc §3.4): a byte-stable `operator` opener row is persisted FIRST
  // (folded into the leading user turn so the greeting never sits first in the
  // API history), then the greeting streams + persists as the agent's message.
  // Idempotent-ish: a second call on a session that already has messages → 409.
  app.post("/chats/:id/open", async (c) => {
    const sessionId = c.req.param("id");
    const token = c.req.header("x-session-token") ?? undefined;
    if (!(await chatTokenValid(sessionId, token))) return c.json({ error: "unauthorized" }, 401);
    // Guard 404/409 BEFORE opening the SSE stream so the client gets a clean
    // status code rather than an empty stream. The 409 guard checks for ANY
    // persisted row (including the hidden operator opener), so a rapid second
    // /open 409s even before the agent's visible reply lands.
    const transcript = await getChatTranscript(sessionId);
    if (!transcript) return c.json({ error: "unknown session" }, 404);
    if (await chatHasAnyMessage(sessionId)) {
      return c.json({ error: "already opened", reason: "already" }, 409);
    }
    return streamSSE(c, async (stream) => {
      await openGreeting(sessionId, {
        onFrame: async (frame) => {
          await stream.writeSSE({ data: JSON.stringify(frame) });
        },
      });
    });
  });

  // --- POST /chats/:id/ping -----------------------------------------------
  // Token-gated liveness ping (design doc §3.4). WorldClient pings every 60s
  // while the panel is open; the sweep keeps the session alive as long as pings
  // OR messages keep arriving.
  app.post("/chats/:id/ping", async (c) => {
    const sessionId = c.req.param("id");
    const token = c.req.header("x-session-token") ?? undefined;
    if (!(await chatTokenValid(sessionId, token))) return c.json({ error: "unauthorized" }, 401);
    await pingChat(sessionId);
    return c.json({ ok: true });
  });

  // --- GET /chats/:id (transcript recovery; token-gated) ------------------
  // Returns the session + VISIBLE transcript (operator rows never exposed) so a
  // dropped stream can rehydrate the panel (design doc §3.4, §5).
  app.get("/chats/:id", async (c) => {
    const sessionId = c.req.param("id");
    const token = c.req.header("x-session-token") ?? undefined;
    if (!(await chatTokenValid(sessionId, token))) return c.json({ error: "unauthorized" }, 401);
    const transcript = await getChatTranscript(sessionId);
    if (!transcript) return c.json({ error: "unknown session" }, 404);
    return c.json(validated(GetChatResponse, transcript));
  });

  // --- POST /chats/:id/messages {text} → SSE ChatStreamFrame stream -------
  // Token-gated. Emits the contract ChatStreamFrame union as SSE `data` (the
  // `type` field is the discriminator — no SSE event names). `done` carries the
  // real persisted messageId; `suggested_replies` follows AFTER `done` and never
  // blocks it. operatorNote is server-internal — NOT read from the request body.
  app.post("/chats/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const token = c.req.header("x-session-token") ?? undefined;
    if (!(await chatTokenValid(sessionId, token))) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return c.json({ error: "text required" }, 400);

    return streamSSE(c, async (stream) => {
      await runChatTurn(sessionId, text, {
        onFrame: async (frame) => {
          // Each frame is one SSE `data` payload; the `type` field discriminates.
          await stream.writeSSE({ data: JSON.stringify(frame) });
        },
      });
      // suggested_replies rides AFTER done — never on the latency path. A
      // failure here yields no chips; it must not break the stream.
      try {
        const replies = await suggestedReplies(sessionId);
        if (replies.length) {
          await stream.writeSSE({
            data: JSON.stringify({ type: "suggested_replies", replies }),
          });
        }
      } catch {
        /* best-effort — swallow */
      }
    });
  });

  // --- POST /chats/:id/close ----------------------------------------------
  // Token-gated.
  app.post("/chats/:id/close", async (c) => {
    const sessionId = c.req.param("id");
    const token = c.req.header("x-session-token") ?? undefined;
    if (!(await chatTokenValid(sessionId, token))) return c.json({ error: "unauthorized" }, 401);
    await endChat(sessionId);
    return c.json({ ok: true });
  });

  // --- POST /admin/tick/:agentId — force one tick (smoke tests) -----------
  app.post("/admin/tick/:agentId", async (c) => {
    // Guard: ADMIN_TOKEN when set, otherwise allowed off-production (brief).
    if (config.adminToken) {
      const provided = c.req.header("x-admin-token");
      if (provided !== config.adminToken) return c.json({ error: "forbidden" }, 403);
    } else if (config.nodeEnv === "production") {
      return c.json({ error: "forbidden" }, 403);
    }
    const id = c.req.param("agentId");
    if (!isAgentId(id)) return c.json({ error: "unknown agent" }, 404);
    const result = await runTick(id);
    // Force-flush the trace so a smoke test can verify it immediately (OTel
    // batches by default). No-op when Langfuse is off.
    await flushTracing();
    return c.json(result);
  });

  // --- GET /debug — dead-simple server-rendered status page ---------------
  app.get("/debug", async (c) => {
    const [snapshot, agents, spend] = await Promise.all([
      buildSnapshot(),
      allAgents(),
      spendTodayUsd(),
    ]);
    const feed = await getFeed(undefined, undefined, 60);
    return c.html(renderDebugPage({ snapshot, agents, spendTodayUsd: spend, feed: feed.items }));
  });

  return app;
}

// --- mappers ---------------------------------------------------------------
function toArtifact(row: Awaited<ReturnType<typeof getArtifact>> & {}) {
  return {
    id: row!.id,
    agentId: row!.agentId,
    kind: row!.kind,
    title: row!.title,
    body: row!.body,
    locationId: row!.locationId ?? null,
    fixture: row!.fixture ?? null,
    createdAt: row!.createdAt.toISOString(),
    updatedAt: row!.updatedAt.toISOString(),
    published: row!.published,
  };
}

function toArtifactSummary(row: {
  id: string;
  agentId: string;
  kind: string;
  title: string;
  locationId: string | null;
  fixture: string | null;
  createdAt: Date;
  updatedAt: Date;
  published: boolean;
}): ArtifactSummary {
  // The enum columns are stored as their narrow literal sets at the DB layer;
  // cast them onto the contract's literal types here (the row originates from a
  // typed drizzle select, so these are sound).
  return {
    id: row.id,
    agentId: row.agentId as ArtifactSummary["agentId"],
    kind: row.kind as ArtifactSummary["kind"],
    title: row.title,
    locationId: row.locationId as ArtifactSummary["locationId"],
    fixture: row.fixture ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    published: row.published,
  };
}
