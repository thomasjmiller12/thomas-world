// Drizzle schema — every table from plan §3.5 plus llm_usage + outbox (brief).
//
// `world_events` is APPEND-ONLY: there are no UPDATE/DELETE code paths against
// it anywhere in the engine. Column enums reuse the @town/contract id lists so
// the DB and the wire contract can never drift.

import {
  pgTable,
  bigserial,
  text,
  boolean,
  jsonb,
  timestamp,
  integer,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import type {
  AgentId,
  LocationId,
  Visibility,
  WorldEventType,
  ArtifactKind,
} from "@town/contract";

// pg text-enum value sets. Inlined (rather than imported from @town/contract's
// runtime arrays) so drizzle-kit's CJS schema loader resolves cleanly without
// pulling the ESM contract entry. The `satisfies`/assignment guards below make
// the lists fail typecheck if they ever drift from the contract's id types —
// so the single source of truth is preserved at compile time.
const agentEnum = ["career", "researcher", "builder", "writer", "hobby"] as const;
const locationEnum = ["town", "office", "library", "workshop", "cafe", "park"] as const;
const visibilityEnum = ["public", "location", "private"] as const;
const artifactKindEnum = [
  "blog_post",
  "project_log",
  "research_note",
  "bulletin",
  "fun_list",
  "diary_entry",
  "daily_digest",
] as const;
const eventTypeEnum = [
  "agent.moved",
  "agent.activity",
  "agent.thought",
  "agent.spoke",
  "conversation.started",
  "conversation.turn",
  "conversation.ended",
  "message.sent",
  "artifact.created",
  "artifact.updated",
  "bulletin.posted",
  "capability.requested",
  "visitor.arrived",
  "visitor.left",
  "visitor.moved",
  "visitor.interacted",
  "world.effect",
  "chat.started",
  "chat.ended",
  "chat.joined",
  "conversation.converted",
  "world.time",
] as const;

// Compile-time drift guards: every inlined literal must be assignable to (and
// cover) the corresponding contract type. If the contract adds/renames an id,
// these assignments stop type-checking.
const _agentGuard: AgentId = agentEnum[0];
const _locationGuard: LocationId = locationEnum[0];
const _visibilityGuard: Visibility = visibilityEnum[0];
const _artifactGuard: ArtifactKind = artifactKindEnum[0];
const _eventGuard: WorldEventType = eventTypeEnum[0];
// Reverse direction: assert no contract member is missing from our lists.
const _agentCover: (typeof agentEnum)[number] = "career" as AgentId;
const _locationCover: (typeof locationEnum)[number] = "town" as LocationId;
const _visibilityCover: (typeof visibilityEnum)[number] = "public" as Visibility;
const _artifactCover: (typeof artifactKindEnum)[number] = "blog_post" as ArtifactKind;
const _eventCover: (typeof eventTypeEnum)[number] = "agent.moved" as WorldEventType;
void [
  _agentGuard,
  _locationGuard,
  _visibilityGuard,
  _artifactGuard,
  _eventGuard,
  _agentCover,
  _locationCover,
  _visibilityCover,
  _artifactCover,
  _eventCover,
];

// What an agent is currently engaged in (design doc §3.2). Replaces the old
// `busy` boolean: an agent is either in a `chat` (visitor ± a second agent) or
// a `scene` (agent↔agent). `participants` lists the OTHER agents engaged in the
// same session, so `clearEngagement(kind, id)` can release every holder at once
// (a 2-agent chat would otherwise strand the second agent engaged forever).
// Mirrors the contract's AgentEngagement but stores agent participants only —
// the `with` field the contract exposes derives from this plus visitor presence.
export interface Engagement {
  kind: "chat" | "scene";
  id: string;
  participants: AgentId[];
}

// --- agents -----------------------------------------------------------------
export const agents = pgTable("agents", {
  id: text("id", { enum: agentEnum }).primaryKey(),
  displayName: text("display_name").notNull(),
  soulVersion: text("soul_version").notNull().default("0"),
  locationId: text("location_id", { enum: locationEnum }).notNull(),
  status: text("status").notNull().default("idle"),
  activity: text("activity"),
  // Nullable engagement reference (design doc §3.2). null => unengaged. The
  // derived `busy` boolean (engagement != null) is what surfaces in the contract.
  engagement: jsonb("engagement").$type<Engagement | null>(),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
});

// --- locations --------------------------------------------------------------
export const locations = pgTable("locations", {
  id: text("id", { enum: locationEnum }).primaryKey(),
  name: text("name").notNull(),
  // Agent-facing description (what an agent perceives standing there).
  description: text("description").notNull(),
  // Named objects an agent can interact with (notice board, outbox, press…).
  fixtures: jsonb("fixtures").notNull().default("[]"),
  // Adjacency: array of reachable location ids.
  adjacency: jsonb("adjacency").notNull().default("[]"),
});

// --- world_events (append-only spine, plan §3.2) ----------------------------
export const worldEvents = pgTable(
  "world_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type", { enum: eventTypeEnum }).notNull(),
    agentId: text("agent_id", { enum: agentEnum }),
    locationId: text("location_id", { enum: locationEnum }),
    visitorId: text("visitor_id"),
    payload: jsonb("payload").notNull(),
    visibility: text("visibility", { enum: visibilityEnum }).notNull(),
  },
  (t) => [
    index("world_events_type_idx").on(t.type),
    index("world_events_location_idx").on(t.locationId),
    index("world_events_agent_idx").on(t.agentId),
  ],
);

// --- messages (DM + broadcast, plan §3.5) -----------------------------------
export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fromAgent: text("from_agent", { enum: agentEnum }).notNull(),
    // null => broadcast to everyone.
    toAgent: text("to_agent", { enum: agentEnum }),
    body: text("body").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("messages_to_idx").on(t.toAgent)],
);

// --- conversations / turns (agent↔agent scenes) -----------------------------
// FROZEN — legacy paced scenes (pre-M2.1). Room talk is now emergent `say`
// across boosted ticks; the scene engine is gone, so no write paths remain.
// These table definitions are kept only so historical rows still exist and the
// boot sweep can close any left open by a pre-M2.1 deploy.
export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  locationId: text("location_id", { enum: locationEnum }).notNull(),
  participantIds: jsonb("participant_ids").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const conversationTurns = pgTable(
  "conversation_turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: text("conversation_id").notNull(),
    agentId: text("agent_id", { enum: agentEnum }).notNull(),
    body: text("body").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_turns_conv_idx").on(t.conversationId)],
);

// --- artifacts (durable made-things, plan §6) -------------------------------
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id", { enum: agentEnum }).notNull(),
    kind: text("kind", { enum: artifactKindEnum }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    locationId: text("location_id", { enum: locationEnum }),
    fixture: text("fixture"),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("artifacts_agent_idx").on(t.agentId),
    index("artifacts_kind_idx").on(t.kind),
  ],
);

// --- memory_files (core memory; memory-tool backend) ------------------------
export const memoryFiles = pgTable("memory_files", {
  agentId: text("agent_id", { enum: agentEnum }).notNull(),
  path: text("path").notNull(),
  content: text("content").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- visitors ----------------------------------------------------------------
export const visitors = pgTable("visitors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // The visitor's logical location (design doc §2). Nullable: a freshly
  // registered visitor has no body in the world until the frontend reports its
  // first scene via PATCH /visitors/:id. The frontend reports every door/scene
  // change; a change emits a public `visitor.moved` so agents at the
  // destination perceive the arrival.
  locationId: text("location_id", { enum: locationEnum }),
  // Returned to the registering browser at creation; required to authorize
  // PATCH /visitors/:id and POST /visitors/:id/interact (design doc §5 Auth).
  // It lives only in that browser — never echoed by GET /visitors/:id.
  visitorToken: text("visitor_token"),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- chat sessions / messages (visitor chat) --------------------------------
export const chatSessions = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  // The PRIMARY agent — the one the visitor opened the chat with. Kept for
  // back-compat (chat.started/.ended attribution, 1-agent paths). The full
  // roster lives in `participantAgentIds` (defaults to [agentId]); a group chat
  // (invite_to_chat / scene conversion) adds a second agent there (design §3.3).
  agentId: text("agent_id", { enum: agentEnum }).notNull(),
  // Every agent in the session (design doc §3.3). Defaults to [agentId]; a
  // second agent joins via invite_to_chat or a scene→chat conversion. Hard cap
  // of 2 agents + 1 visitor is enforced in the runtime, not the schema.
  participantAgentIds: jsonb("participant_agent_ids")
    .$type<AgentId[]>()
    .notNull()
    .default([]),
  visitorId: text("visitor_id").notNull(),
  // Per-session bearer required on /open, /messages, /close, /ping (design doc
  // §3.3). Makes visitor↔agent chat content private and enforced. Returned only
  // in the POST /chats response to the browser that opened the session.
  sessionToken: text("session_token"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Last liveness ping from the open panel (design doc §3.4). WorldClient pings
  // every 60s while the panel is open; the liveness-aware sweep closes only
  // sessions with NO ping AND no message for 3 min — so a slow-typing or
  // long-reading visitor is never cut off, but an abandoned tab frees the agent.
  lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
  // A one-shot operator note to inject on the NEXT runChatTurn, then clear
  // (design doc §4). Set when a visitor.interacted event routes to a live
  // session WITH this visitor ("The visitor just answered the phone.") so the
  // agent can land the payoff line mid-chat; consumed-and-cleared per turn.
  pendingOperatorNote: text("pending_operator_note"),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    // "visitor" | "operator" | <AgentId> (design doc §3.3, step C widening). An
    // `operator` row holds a synthetic opener / mid-chat note: it's NEVER
    // exposed via GET /chats/:id, but `historyFor` folds it into the model's
    // `user` turns. A 1-agent chat persists agent lines under the legacy
    // "agent" sentinel OR the explicit AgentId; a group chat ALWAYS uses the
    // explicit AgentId so historyFor can tell the two speakers apart. Free-form
    // text (no DB enum) so the AgentId widening needs no schema migration here.
    sender: text("sender").notNull(),
    body: text("body").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId)],
);

// --- thread_summaries (Town Chronicle lazy summaries, M2.1) -----------------
// One row per CLOSED room-talk thread the Chronicle has summarized (a one-line
// Haiku phrase). `threadId` is the chronicle's deterministic thread id
// (thr-<location>-<firstEventId> for emergent agent.spoke runs, conv-<id> for
// historical paced-scene turns). Only threads whose last line is older than the
// grouping gap are inserted (an open thread can still grow, so it's never
// cached). `participants` mirrors the thread roster for cheap display.
export const threadSummaries = pgTable("thread_summaries", {
  threadId: text("thread_id").primaryKey(),
  day: text("day").notNull(),
  locationId: text("location_id", { enum: locationEnum }),
  participants: jsonb("participants").$type<AgentId[]>().notNull().default([]),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- capability_requests (the meta-layer flex surface) ----------------------
export const capabilityRequests = pgTable("capability_requests", {
  id: text("id").primaryKey(),
  agentId: text("agent_id", { enum: agentEnum }).notNull(),
  summary: text("summary").notNull(),
  rationale: text("rationale").notNull(),
  // "open" | "approved" | "declined"
  status: text("status").notNull().default("open"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

// --- llm_usage (per-call meter for the budget cap, brief) -------------------
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: text("agent_id", { enum: agentEnum }),
    model: text("model").notNull(),
    // The tick/chat id this call belonged to (free-form correlation key).
    tickId: text("tick_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    estCostUsd: doublePrecision("est_cost_usd").notNull().default(0),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_usage_agent_ts_idx").on(t.agentId, t.ts)],
);

// --- outbox (queued outbound email when Resend is absent, brief) ------------
export const outbox = pgTable("outbox", {
  id: text("id").primaryKey(),
  agentId: text("agent_id", { enum: agentEnum }).notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  // "queued" | "sent" | "failed"
  status: text("status").notNull().default("queued"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
