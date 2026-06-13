// Hono HTTP layer (plan §5). All read endpoints derive from the event log /
// engine helpers; the only writes here are visitor registration and the chat
// stubs the runtime phase fills in. SSE drives the live frontend.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { AgentId, ArtifactKind, MessageScope } from "@town/contract";
import {
  agentIds,
  locationIds,
  artifactKinds,
  HealthResponse,
  SnapshotResponse,
  EventsResponse,
  FeedResponse,
  ChronicleResponse,
  AgentProfileResponse,
  MessagesResponse,
  CreateVisitorResponse,
  GetVisitorResponse,
  PatchVisitorRequest,
  CreateChatResponse,
  GetChatResponse,
  InteractRequest,
} from "@town/contract";
import type { LocationId } from "@town/contract";
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
import { getChronicle, todayUtc } from "../engine/chronicle.js";
import { getAgent, allAgents } from "../engine/agents.js";
import { listMessages } from "../engine/messages.js";
import {
  listArtifacts,
  getArtifact,
} from "../engine/artifacts.js";
import {
  registerVisitor,
  visitorConnected,
  visitorDisconnected,
  touchVisitor,
  getVisitor,
  visitorTokenValid,
  moveVisitor,
  renameVisitor,
} from "../engine/visitors.js";
import { agentsAtLocation, getLocation } from "../engine/locations.js";
import { appendEvent } from "../engine/events.js";
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
  pingChat,
  getChatTranscript,
  routeVisitorInteraction,
  routeVisitorMovement,
} from "../runtime/chat.js";
import type { FixtureDef } from "../runtime/fixtures.js";
import {
  createRateLimiters,
  clientIp,
  parseCorsOrigins,
  IN_FICTION_429,
  sessionTurnDecision,
  SESSION_WRAP_UP_NOTE,
} from "./rate-limit.js";
import { visitorTurnCount } from "../runtime/chat.js";

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

// Localhost dev origins allowed when CORS_ORIGINS is unset (design doc §7). The
// Vercel prod/preview origins are added via the env var in production (see
// README.md). Includes the static-export dev server (3000) and the world server
// itself (8787) so the /debug page and same-origin tools keep working.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

export function createApp() {
  const app = new Hono();

  // CORS allowlist (design doc §7): replace the wildcard with an env-driven
  // allowlist. `origin` is a function so we echo the request origin ONLY when it
  // is on the list (returning the matched origin, not "*", which is required for
  // credentialed requests and is simply correct hygiene). Unlisted origins get
  // no CORS headers → the browser blocks the cross-origin read.
  const allowlist = parseCorsOrigins(config.corsOrigins) ?? DEFAULT_DEV_ORIGINS;
  const allowSet = new Set(allowlist);
  app.use(
    "*",
    cors({
      origin: (origin) => (allowSet.has(origin.replace(/\/+$/, "")) ? origin : null),
      allowHeaders: ["Content-Type", "x-visitor-token", "x-session-token", "x-admin-token", "Last-Event-ID"],
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    }),
  );

  // In-memory rate limiters (design doc §7) — one set for the process lifetime.
  const limits = createRateLimiters();

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
    // SSE concurrency limit (design doc §7): 2 per IP + 200 global. Acquire a
    // slot BEFORE opening the stream; on a cap, return a clean 429 with in-fiction
    // copy rather than an empty/aborted stream. The slot is released on abort.
    const ip = clientIp(c.req.header("x-forwarded-for"), getConnInfo(c).remote.address);
    const slot = limits.sse.acquire(ip);
    if (!slot.ok) {
      const message =
        slot.reason === "per-key" ? IN_FICTION_429.sseConcurrent : IN_FICTION_429.sseGlobal;
      return c.json({ error: "too many connections", message }, 429);
    }
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
            // lastSeenAt is read before the touch so the presence debounce can
            // tell a transport reconnect from a real arrival.
            const arrived = await visitorConnected(v.id, v.name, v.lastSeenAt);
            await touchVisitor(v.id);
            // A REAL arrival (not a proxy-recycle reconnect) wakes the agents
            // wherever the visitor is standing, same boost band as a room
            // change — so a visit gets acknowledged in ~30-60s instead of
            // whenever the slow idle timer happens to fire next.
            if (arrived && v.locationId) {
              const here = await agentsAtLocation(v.locationId as LocationId).catch(() => []);
              for (const a of here) {
                void boostAgent(a.id as AgentId, `${v.id}|${a.id}`).catch((err) =>
                  console.warn(`[sse] arrival boost ${a.id} failed:`, (err as Error).message),
                );
              }
            }
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
        slot.release(); // free the SSE concurrency slot (idempotent)
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
        slot.release(); // free the SSE concurrency slot (idempotent w/ onAbort)
        // Departure goes through the presence debounce: it only becomes a
        // world event if the visitor stays gone past the grace window.
        if (presentVisitor) visitorDisconnected(presentVisitor.id);
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

  // --- GET /chronicle?day=YYYY-MM-DD --------------------------------------
  // The Town Chronicle hub (design doc M2.1): one day's grouped emergent life
  // (threads, artifacts, bulletins, effects, presence). Public read. `day`
  // defaults to today (UTC); a malformed day → 400. Thread summaries fill
  // lazily (capped per request) — see engine/chronicle.ts.
  app.get("/chronicle", async (c) => {
    const day = c.req.query("day") ?? todayUtc();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return c.json({ error: "bad day", message: "day must be YYYY-MM-DD" }, 400);
    }
    let payload;
    try {
      payload = await getChronicle(day);
    } catch {
      // dayBounds throws on a day that passes the regex but isn't a real date.
      return c.json({ error: "bad day", message: "day must be YYYY-MM-DD" }, 400);
    }
    return c.json(validated(ChronicleResponse, payload));
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
    // Visitor-creation limit (design doc §7): 5/hour per IP. This guards only NEW
    // registration; a returning visitor re-validates via GET /visitors/:id
    // (unlimited) and is thus exempt by construction — only a flood of fresh
    // names from one IP trips this.
    const ip = clientIp(c.req.header("x-forwarded-for"), getConnInfo(c).remote.address);
    if (!limits.visitorCreate.hit(ip, Date.now())) {
      return c.json({ error: "too many new visitors", message: IN_FICTION_429.visitorCreate }, 429);
    }
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
          // Ordered-pair throttle key (visitor → agent), default 5-min window.
          void boostAgent(a.id as AgentId, `${id}|${a.id}`).catch((err) =>
            console.warn(`[visitors] boost ${a.id} failed:`, (err as Error).message),
          );
        }
        // Route the move into any LIVE chat session of this visitor (M2.1): a
        // chat is a channel, not proximity-gated, so the visitor walking off (or
        // toward the agent) lands as a pending operator note rather than ending
        // the session. Best-effort, alongside the boost fan-out — never blocks
        // the PATCH response.
        void routeVisitorMovement({
          visitorId: id,
          // `name` may have just been renamed in this same request; prefer it.
          visitorName: name?.trim() || v.name,
          from: (moved.from ?? locationId) as LocationId,
          to: locationId as LocationId,
        }).catch((err) =>
          console.warn(`[visitors] movement route failed:`, (err as Error).message),
        );
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
  // Visitor-token authorized (design doc §4). Validates the fixture exists at the
  // location, emits a public `visitor.interacted`, then ROUTES: if an agent in a
  // live chat session with THIS visitor is at the location, a pending operator
  // note lands on that session (consumed next runChatTurn); otherwise the
  // interaction is perceived next tick via the event log automatically.
  app.post("/visitors/:id/interact", async (c) => {
    const id = c.req.param("id");
    const v = await getVisitor(id);
    if (!v) return c.json({ error: "unknown visitor" }, 404);
    const token = c.req.header("x-visitor-token");
    if (!(await visitorTokenValid(id, token))) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const parsed = InteractRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    const { locationId, fixture } = parsed.data;

    // The fixture must actually exist at the location (no whitelist on the
    // action here — a visitor "answering the phone" isn't a gated agent action).
    const loc = await getLocation(locationId as LocationId);
    if (!loc) return c.json({ error: "unknown location" }, 404);
    const fixtures = (loc.fixtures as FixtureDef[]) ?? [];
    if (!fixtures.some((f) => f.id === fixture)) {
      return c.json({ error: "no such fixture here" }, 404);
    }

    await appendEvent({
      type: "visitor.interacted",
      visitorId: id,
      locationId: locationId as LocationId,
      visibility: "public",
      payload: { visitorId: id, name: v.name, location: locationId, fixture },
    });

    const routedSessionId = await routeVisitorInteraction({
      visitorId: id,
      visitorName: v.name,
      locationId: locationId as LocationId,
      fixture,
    });

    return c.json({ ok: true, routed: Boolean(routedSessionId) });
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

    // Per-visitor chat limits + session turn cap (design doc §7). The session's
    // visitor is the rate-limit subject (the session token already authenticated
    // the caller, so the visitorId is trusted). We read the session once.
    const session = await getChatTranscript(sessionId);
    if (!session) return c.json({ error: "unknown session" }, 404);
    const now = Date.now();
    if (!limits.chatPerMinute.hit(session.visitorId, now)) {
      return c.json({ error: "too fast", message: IN_FICTION_429.chatPerMinute }, 429);
    }
    if (!limits.chatPerDay.hit(session.visitorId, now)) {
      return c.json({ error: "daily limit", message: IN_FICTION_429.chatPerDay }, 429);
    }
    // 40-turn session cap: block once reached; inject an in-character wrap-up
    // operator note as the turn approaches ~36 so the agent winds down in voice.
    const priorTurns = await visitorTurnCount(sessionId);
    const turn = sessionTurnDecision(priorTurns);
    if (turn.block) {
      return c.json({ error: "session full", message: IN_FICTION_429.chatPerDay }, 429);
    }
    const wrapUpNote = turn.wrapUp ? SESSION_WRAP_UP_NOTE : undefined;

    return streamSSE(c, async (stream) => {
      const turn = await runChatTurn(
        sessionId,
        text,
        {
          onFrame: async (frame) => {
            // Each frame is one SSE `data` payload; the `type` field discriminates.
            await stream.writeSSE({ data: JSON.stringify(frame) });
          },
        },
        wrapUpNote,
      );
      // suggested_replies rides AFTER done — never on the latency path. A
      // failure here yields no chips; it must not break the stream. Skip them
      // entirely when the agent ENDED the chat itself (leave_chat): chips
      // prompting the visitor to reply into a closed session make no sense.
      if (turn.ended) return;
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
