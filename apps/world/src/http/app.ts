// Hono HTTP layer (plan §5). All read endpoints derive from the event log /
// engine helpers; the only writes here are visitor registration and the chat
// stubs the runtime phase fills in. SSE drives the live frontend.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { AgentId, ArtifactKind, MessageScope } from "@town/contract";
import { agentIds, locationIds, artifactKinds } from "@town/contract";
import { config } from "../config.js";
import { buildSnapshot } from "../engine/snapshot.js";
import {
  eventsAfter,
  recentEventsForAgent,
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
} from "../engine/visitors.js";
import { subscribe } from "../engine/bus.js";
import { spendTodayUsd } from "../engine/usage.js";
import { renderDebugPage } from "./debug.js";
import { runTick } from "../runtime/tick.js";
import { flushTracing } from "../runtime/tracing.js";
import { openChat, endChat, runChatTurn, sanitizeVisitorText } from "../runtime/chat.js";

const agentSet = new Set<string>(agentIds);
const locationSet = new Set<string>(locationIds);
const artifactKindSet = new Set<string>(artifactKinds);

function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && agentSet.has(v);
}

export function createApp() {
  const app = new Hono();

  app.use("*", cors());

  // --- health -------------------------------------------------------------
  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  // --- GET /world/snapshot -------------------------------------------------
  app.get("/world/snapshot", async (c) => {
    return c.json(await buildSnapshot());
  });

  // --- GET /events?after=<id> (polling/catch-up) --------------------------
  app.get("/events", async (c) => {
    const after = c.req.query("after");
    const events = await eventsAfter(after);
    return c.json({ events });
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
          for (const e of batch) {
            await stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(e) });
            backlogHigh = Math.max(backlogHigh, Number(e.id));
          }
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
    const { items, nextCursor } = await getFeed(agent, cursor);
    return c.json({ items, nextCursor });
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
    return c.json({
      agent: {
        id: a.id,
        displayName: a.displayName,
        locationId: a.locationId,
        status: a.status,
        activity: a.activity ?? null,
        busy: a.busy,
        lastTickAt: a.lastTickAt ? a.lastTickAt.toISOString() : null,
      },
      recentArtifacts: artifactRows.map(toArtifactSummary),
      recentEvents: recent,
    });
  });

  // --- GET /messages?scope=broadcast|dm&cursor= ---------------------------
  app.get("/messages", async (c) => {
    const scopeParam = c.req.query("scope");
    const scope: MessageScope | undefined =
      scopeParam === "broadcast" || scopeParam === "dm" ? scopeParam : undefined;
    const cursor = c.req.query("cursor");
    const { rows, nextCursor } = await listMessages(scope, cursor);
    return c.json({
      messages: rows.map((m) => ({
        id: String(m.id),
        from: m.fromAgent,
        to: m.toAgent ?? null,
        body: m.body,
        ts: m.ts.toISOString(),
        readAt: m.readAt ? m.readAt.toISOString() : null,
      })),
      nextCursor,
    });
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
    return c.json({ visitorId: v.id, name: v.name });
  });

  // --- POST /chats {agentId, visitorId} -----------------------------------
  // Opens a chat session: the agent goes busy, idle ticks skip it (plan §4.1).
  app.post("/chats", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = body?.agentId;
    const visitorId = body?.visitorId;
    if (!isAgentId(agentId)) return c.json({ error: "unknown agent" }, 404);
    if (typeof visitorId !== "string" || !visitorId) {
      return c.json({ error: "visitorId required" }, 400);
    }
    const res = await openChat(agentId, visitorId);
    // null → unknown agent or the agent is already busy (one live chat per agent).
    if (!res) return c.json({ error: "agent unavailable (busy or unknown)" }, 409);
    return c.json({ sessionId: res.sessionId });
  });

  // --- POST /chats/:id/messages {text} → SSE token stream -----------------
  app.post("/chats/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return c.json({ error: "text required" }, 400);
    // Optional one-shot operator note (e.g. continuity context); model-gated
    // injection handled inside runChatTurn. It enters the model in the SYSTEM
    // role (higher trust than visitor text) so treat it with the same distrust:
    // cap length and strip the common injection scaffolding before it's injected.
    const operatorNote =
      typeof body?.operatorNote === "string"
        ? sanitizeVisitorText(body.operatorNote).slice(0, 500)
        : undefined;

    return streamSSE(c, async (stream) => {
      const result = await runChatTurn(
        sessionId,
        text,
        {
          onText: async (delta) => {
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: delta }) });
          },
        },
        operatorNote,
      );
      await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: result.ok }) });
    });
  });

  // --- POST /chats/:id/close ----------------------------------------------
  app.post("/chats/:id/close", async (c) => {
    await endChat(c.req.param("id"));
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
}) {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    title: row.title,
    locationId: row.locationId ?? null,
    fixture: row.fixture ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    published: row.published,
  };
}
