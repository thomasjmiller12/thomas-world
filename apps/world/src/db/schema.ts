// Drizzle schema — every table from plan §3.5 plus llm_usage + outbox (brief).
//
// `world_events` is APPEND-ONLY: there are no UPDATE/DELETE code paths against
// it anywhere in the engine. Column enums reuse the @town/contract id lists so
// the DB and the wire contract can never drift.

import { randomUUID } from "node:crypto";
import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  jsonb,
  timestamp,
  integer,
  doublePrecision,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import type {
  AgentId,
  LocationId,
  Visibility,
  WorldEventType,
  ArtifactKind,
  ShareCard,
  ChronicleIssueSection,
  ChronicleCitation,
  ObjectPlacement,
  WorldObjectState,
  ObjectNote,
  SemanticZone,
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
  "interactive",
  "shared_page",
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
  "visitor.escorted",
  "world.effect",
  "chat.started",
  "chat.ended",
  "chat.joined",
  "conversation.converted",
  "world.time",
  "object.created",
  "object.removed",
  "object.moved",
  "object.state_changed",
  "object.attached",
  "object.noted",
  "artifact.state_changed",
  "world.beat",
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
  // A semantic zone WITHIN locationId (Phase C.5, space addressing) — e.g.
  // "park.bench-area". Null = "just in the room, no specific spot known".
  // Set by moveAgent when a targetZone is given; cleared on a plain room
  // change (a new room with no spot named means no spot is known there yet).
  zone: text("zone"),
  status: text("status").notNull().default("idle"),
  activity: text("activity"),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
});

// --- agent_threads (M3: continuity) -----------------------------------------
// Each agent's CONTINUOUS thread — the persisted `BetaMessageParam[]` that is
// the agent's consciousness across ticks and chats (incl. server-side
// compaction blocks, which round-trip verbatim — verified Phase 0). One row per
// agent; `content` is loaded into the tool runner to resume and re-persisted
// after every successful turn. `inputCursor` is the high-water world-event id
// already folded into the thread as notice-push (the delta cursor). Like
// agent.locationId, **seed must NEVER reset this** — it's living state.
//
// `content` is intentionally loosely typed (`unknown[]`): importing the SDK's
// ESM BetaMessageParam type here would break drizzle-kit's CJS schema loader
// (same reason the enums above are inlined). engine/thread.ts casts.
export const agentThreads = pgTable("agent_threads", {
  agentId: text("agent_id", { enum: agentEnum }).primaryKey(),
  content: jsonb("content").$type<unknown[]>().notNull().default([]),
  inputCursor: bigint("input_cursor", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  // MUD embodiment: the named-zone registry exposed via the read API (seeded
  // from engine/zones.ts). Additive; fixtures + adjacency untouched.
  zones: jsonb("zones").$type<SemanticZone[]>().notNull().default([]),
  // The location's coarse type (e.g. "interior" | "outdoor"), seeded alongside
  // zones so object templates can later match where they fit. Nullable/additive.
  kind: text("kind"),
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
// FROZEN — legacy paced scenes (pre-M2.1). Room talk is now emergent speech
// across ticks; the scene engine is gone, so no read or write paths remain.
// These table definitions are kept only as a historical archive (Chronicle
// reads historical `conversation.turn` rows from world_events, not from here);
// dropping them would be an irreversible deletion of prod transcript data.
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
    // MUD embodiment: a link to the world_object this artifact is attached to
    // ("a note on the shelf"). Nullable/additive; locationId + fixture kept for
    // back-compat (Chronicle/feed read them).
    objectId: text("object_id"),
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

// --- artifact_state (programmable world, D3) ---------------------------------
// The per-artifact keyed JSON store — the "database" an interactive artifact
// gets for free: a Go board's position, a guestbook's entries, a poll's tallies.
// Visitors write through PUT /artifacts/:id/state/:key (rate-limited,
// size-capped); the owning agent writes through the write_artifact_state tool.
// One row per (artifact, key); a null-value write deletes the row. `updatedBy`
// is an agent id or "visitor:<id>" for provenance.
export const artifactState = pgTable(
  "artifact_state",
  {
    artifactId: text("artifact_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.key] })],
);

// --- world_objects (MUD embodiment: the canonical object graph) -------------
// Promotes today's free-string `locations.fixtures` into first-class, mutable,
// agent-legible furniture instances addressed by SEMANTIC zone (never pixels).
// SHADOW-BUILT in this slice: seeded alongside the still-live fixtures column,
// not yet read by buildDelta/use_fixture (cutover is a later slice). The seed
// upsert NEVER overwrites state/attachedArtifactIds/notes/ownerAgentId, mirroring
// the agents.locationId discipline so agent mutations survive re-seed.
export const worldObjects = pgTable(
  "world_objects",
  {
    // Stable slug `<location>.<slug>`, human-stable for idempotent seeding.
    id: text("id").primaryKey(),
    // A library.json object NAME (the asset-vocabulary bridge). Nullable.
    template: text("template"),
    displayName: text("display_name").notNull(),
    locationId: text("location_id", { enum: locationEnum }).notNull(),
    // The SEMANTIC anchor (a zone id), validated against the zone registry.
    zone: text("zone").notNull(),
    // Renderer hint, filled by the frontend/validation layer; null => pick a spot.
    placement: jsonb("placement").$type<ObjectPlacement | null>(),
    // Small loose state bag; rendered in perception only when non-default.
    state: jsonb("state").$type<WorldObjectState>().notNull().default({}),
    // The verb whitelist (successor to FixtureDef.actions). Empty = decorative.
    affordances: jsonb("affordances").$type<string[]>().notNull().default([]),
    // Carries forward FixtureDef.kind.
    kind: text("kind"),
    // The "note on the shelf" link, denormalized for fast read.
    attachedArtifactIds: jsonb("attached_artifact_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    // Short persistent notes jotted here (leave_note appends).
    notes: jsonb("notes").$type<ObjectNote[]>().notNull().default([]),
    // Who placed/owns it. Null => town commons (seeded fixtures).
    ownerAgentId: text("owner_agent_id", { enum: agentEnum }),
    description: text("description"),
    movable: boolean("movable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("world_objects_location_idx").on(t.locationId),
    index("world_objects_owner_idx").on(t.ownerAgentId),
    index("world_objects_location_zone_idx").on(t.locationId, t.zone),
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
  // A semantic zone WITHIN locationId, approximate (Phase C.5, space
  // addressing) — set to the zone of whatever fixture the visitor last
  // interacted with; null = no specific spot known. Lets an agent resolve
  // "where the visitor is" with the same zone vocabulary used everywhere
  // else, without tracking raw pixels server-side. Cleared on a room change.
  zone: text("zone"),
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
    // Share cards attached to this message (M2.2 — Part 4). Agents drop concrete
    // cards mid-chat (artifact / external reference / proof); they're persisted
    // here so a dropped panel rehydrates them. Empty for ordinary lines.
    attachments: jsonb("attachments").$type<ShareCard[]>().notNull().default([]),
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

// --- chronicle_issues (the LLM Town Crier newspaper, M2.2 — Part 1) ----------
// One world-authored newspaper issue per day. Unlike artifacts (agent-authored),
// a Town Crier issue is editorial synthesis the world prints, so it lives in its
// own table — keeping the artifact economy agent-authored. `citations` resolve
// every concrete claim back to a real record; the source*Ids arrays record the
// packet so an issue is auditable/regenerable. `status` is ready|fallback|empty
// |failed (the deterministic fallback issue keeps the UI shaped when the LLM is
// unavailable). Past days are immutable; today caches for a short TTL.
export const chronicleIssues = pgTable("chronicle_issues", {
  day: text("day").primaryKey(), // YYYY-MM-DD, UTC (same partition as /chronicle)
  status: text("status").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  byline: text("byline").notNull().default("The Town Crier"),
  bodyMd: text("body_md").notNull(),
  sections: jsonb("sections").$type<ChronicleIssueSection[]>().notNull().default([]),
  citations: jsonb("citations").$type<ChronicleCitation[]>().notNull().default([]),
  sourceEventIds: jsonb("source_event_ids").$type<string[]>().notNull().default([]),
  sourceArtifactIds: jsonb("source_artifact_ids").$type<string[]>().notNull().default([]),
  sourceThreadIds: jsonb("source_thread_ids").$type<string[]>().notNull().default([]),
  sourceReferenceIds: jsonb("source_reference_ids").$type<string[]>().notNull().default([]),
  model: text("model"),
  promptVersion: text("prompt_version").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- external_references (curated public catalog, M2.2 — Part 3) -------------
// Thomas-owned (not agent-authored) public references agents may share as cards:
// projects, repos, demos, writing, resume/company entries. An ALLOWLIST — only
// `public` rows are shareable, and the share tools accept ids, never raw URLs.
// Seeded from curated data at deploy; `sourcePath` records a vault origin if synced.
export const externalReferences = pgTable(
  "external_references",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    shortTitle: text("short_title"),
    summary: text("summary").notNull(),
    bodyMd: text("body_md"),
    url: text("url"),
    githubUrl: text("github_url"),
    liveUrl: text("live_url"),
    imageUrl: text("image_url"),
    agentIds: jsonb("agent_ids").$type<AgentId[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    public: boolean("public").notNull().default(true),
    sourcePath: text("source_path"),
    sortOrder: integer("sort_order").notNull().default(0),
    featured: boolean("featured").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("external_references_kind_idx").on(t.kind)],
);

// --- portfolio_proofs (curated proof cards, M2.2 — Part 3) -------------------
// Claims with evidence — what the About hub's Proof tab renders, and what agents
// can share as a proof card. Owned by Thomas, not agents. Evidence links point
// at artifacts, world events, and external references.
export const portfolioProofs = pgTable("portfolio_proofs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  claim: text("claim").notNull(),
  summary: text("summary").notNull(),
  bodyMd: text("body_md").notNull(),
  agentIds: jsonb("agent_ids").$type<AgentId[]>().notNull().default([]),
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default([]),
  eventIds: jsonb("event_ids").$type<string[]>().notNull().default([]),
  referenceIds: jsonb("reference_ids").$type<string[]>().notNull().default([]),
  featured: boolean("featured").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

// --- inbound_mail (P-Thomas replies / outside mail into agent inboxes) -------
export const inboundMail = pgTable(
  "inbound_mail",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    providerId: text("provider_id").notNull().unique(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    toAgent: text("to_agent", { enum: agentEnum }),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    html: text("html"),
    raw: jsonb("raw").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inbound_mail_agent_unread_idx").on(t.toAgent, t.readAt),
    index("inbound_mail_provider_idx").on(t.providerId),
  ],
);

// --- agent_presets (Phase B.5 — "customization within bounds", not raw beat
// authoring) -----------------------------------------------------------------
// An agent-saved, NAMED instance of an EXISTING catalog beat's params — e.g.
// Hobby's own emote ("hobby-wave": beat "emote", params {emoji:"🤙"}). The beat
// id + its param schema are still server-validated against @town/contract's
// BEATS at save time AND at play time; a preset can never introduce a new
// mechanic or surface, only a personalized default for one that already
// exists. One name per agent (re-saving overwrites).
export const agentPresets = pgTable(
  "agent_presets",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    agentId: text("agent_id", { enum: agentEnum }).notNull(),
    name: text("name").notNull(),
    beat: text("beat").notNull(),
    params: jsonb("params").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_presets_agent_name_idx").on(t.agentId, t.name)],
);
