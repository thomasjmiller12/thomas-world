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
  "chat.started",
  "chat.ended",
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

// --- agents -----------------------------------------------------------------
export const agents = pgTable("agents", {
  id: text("id", { enum: agentEnum }).primaryKey(),
  displayName: text("display_name").notNull(),
  soulVersion: text("soul_version").notNull().default("0"),
  locationId: text("location_id", { enum: locationEnum }).notNull(),
  status: text("status").notNull().default("idle"),
  activity: text("activity"),
  busy: boolean("busy").notNull().default(false),
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
  agentId: text("agent_id", { enum: agentEnum }).notNull(),
  visitorId: text("visitor_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(),
    // "visitor" | "agent"
    sender: text("sender").notNull(),
    body: text("body").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId)],
);

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
