import { z } from "zod";
import { AgentId, LocationId, DayPhase } from "./ids.js";
import { ArtifactKind } from "./artifacts.js";
import { WorldEvent, WorldEventType } from "./events.js";
import { WorldObject, SemanticZone } from "./objects.js";
import { ShareCard } from "./share-cards.js";

// REST request/response shapes for every endpoint in plan §5. Inferred TS
// types are exported alongside each schema. Both apps import these; the typed
// WorldClient on the frontend is built from them.

// --- shared resource entities ----------------------------------------------

export const AgentStatus = z.object({
  id: AgentId,
  displayName: z.string(),
  locationId: LocationId,
  status: z.string(), // free-form: "working", "sleeping (budget)", "in conversation"
  activity: z.string().nullable(),
  lastTickAt: z.string().nullable(), // ISO 8601
});
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Artifact = z.object({
  id: z.string(),
  agentId: AgentId,
  kind: ArtifactKind,
  title: z.string(),
  body: z.string(),
  locationId: LocationId.nullable(),
  fixture: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  published: z.boolean(),
});
export type Artifact = z.infer<typeof Artifact>;

// Headline for list views; `body` omitted (fetch the full Artifact by id).
export const ArtifactSummary = Artifact.omit({ body: true });
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

export const Message = z.object({
  id: z.string(),
  from: AgentId,
  to: AgentId.nullable(), // null => broadcast
  body: z.string(),
  ts: z.string(),
  readAt: z.string().nullable(),
});
export type Message = z.infer<typeof Message>;

// --- GET /world/snapshot ----------------------------------------------------

// World-level state for the initial render (design doc §5): current day phase
// (drives the day/night tint + sleeping fallback), live visitor count, and
// whether the town is awake (false => budget-exhausted / sleeping "dream mode").
export const WorldState = z.object({
  phase: DayPhase,
  visitorsPresent: z.number(),
  awake: z.boolean(),
});
export type WorldState = z.infer<typeof WorldState>;

export const SnapshotResponse = z.object({
  agents: z.array(AgentStatus),
  recentEvents: z.array(WorldEvent),
  world: WorldState,
  // MUD embodiment (additive/optional): the canonical object graph + named zones
  // for the renderer. Optional so older clients/tests parse a snapshot without them.
  objects: z.array(WorldObject).optional(),
  zones: z.array(SemanticZone).optional(),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;

// --- GET /world/objects?location= -------------------------------------------
// The canonical object graph (optionally filtered to one location) + the zone
// registry, for the renderer to subscribe to world state. Read-only, additive.
export const WorldObjectsResponse = z.object({
  objects: z.array(WorldObject),
  zones: z.array(SemanticZone),
});
export type WorldObjectsResponse = z.infer<typeof WorldObjectsResponse>;

// --- GET /health ------------------------------------------------------------

// Liveness + cheap status. `llm` reflects whether the model provider is
// reachable; `budgetExhausted` true => ticks/chat paused, town is "sleeping"
// (the frontend shows dream mode; reads stay live).
export const HealthResponse = z.object({
  ok: z.boolean(),
  ts: z.string(), // ISO 8601
  llm: z.boolean(),
  budgetExhausted: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// --- GET /events?after=<id>  (catch-up / polling fallback) ------------------

export const EventsQuery = z.object({
  after: z.string().optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const EventsResponse = z.object({
  events: z.array(WorldEvent),
});
export type EventsResponse = z.infer<typeof EventsResponse>;

// --- GET /feed?agent=&cursor=  (human-readable day-in-the-life) -------------

export const FeedQuery = z.object({
  agent: AgentId.optional(),
  cursor: z.string().optional(),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export const FeedItem = z.object({
  id: z.string(),
  ts: z.string(),
  agent: AgentId.nullable(),
  line: z.string(), // human-readable rendered line
  // M2 (design doc §5): the source event type (null for synthetic/aggregate
  // rows), the location it happened in (drives "⌖ SHOW IN TOWN"), and the
  // recipient agent for directed events like message.sent (null otherwise).
  type: WorldEventType.nullable(),
  locationId: LocationId.nullable(),
  to: AgentId.nullable(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const FeedResponse = z.object({
  items: z.array(FeedItem),
  nextCursor: z.string().nullable(),
  count: z.number(),
});
export type FeedResponse = z.infer<typeof FeedResponse>;

// --- GET /agents/:id --------------------------------------------------------

export const AgentProfileResponse = z.object({
  agent: AgentStatus,
  recentArtifacts: z.array(ArtifactSummary),
  // last ~5 events — feeds the chat panel's "Before you walked in" rail
  recentEvents: z.array(WorldEvent),
});
export type AgentProfileResponse = z.infer<typeof AgentProfileResponse>;

// --- GET /messages?scope=broadcast|dm&cursor= -------------------------------

export const MessageScope = z.enum(["broadcast", "dm"]);
export type MessageScope = z.infer<typeof MessageScope>;

export const MessagesQuery = z.object({
  scope: MessageScope.optional(),
  cursor: z.string().optional(),
});
export type MessagesQuery = z.infer<typeof MessagesQuery>;

export const MessagesResponse = z.object({
  messages: z.array(Message),
  nextCursor: z.string().nullable(),
});
export type MessagesResponse = z.infer<typeof MessagesResponse>;

// --- GET /artifacts?kind=&agent=  and  GET /artifacts/:id -------------------

export const ArtifactsQuery = z.object({
  kind: ArtifactKind.optional(),
  agent: AgentId.optional(),
});
export type ArtifactsQuery = z.infer<typeof ArtifactsQuery>;

export const ArtifactsResponse = z.object({
  artifacts: z.array(ArtifactSummary),
});
export type ArtifactsResponse = z.infer<typeof ArtifactsResponse>;

export const ArtifactResponse = z.object({
  artifact: Artifact,
});
export type ArtifactResponse = z.infer<typeof ArtifactResponse>;

// --- POST /visitors {name} --------------------------------------------------

export const CreateVisitorRequest = z.object({
  name: z.string().min(1),
});
export type CreateVisitorRequest = z.infer<typeof CreateVisitorRequest>;

export const CreateVisitorResponse = z.object({
  visitorId: z.string(),
  name: z.string(),
  // Returned to the registering browser only; required to authorize subsequent
  // PATCH /visitors/:id and POST /visitors/:id/interact (design doc §5 Auth).
  visitorToken: z.string(),
});
export type CreateVisitorResponse = z.infer<typeof CreateVisitorResponse>;

// --- GET /visitors/:id  (identity validation on boot) -----------------------
// WorldClient validates a stored visitorId here; re-registers on 404. The
// token is NOT echoed — it lives only in the browser that registered.

export const GetVisitorResponse = z.object({
  visitorId: z.string(),
  name: z.string(),
  locationId: LocationId.nullable(),
});
export type GetVisitorResponse = z.infer<typeof GetVisitorResponse>;

// --- PATCH /visitors/:id  {locationId?, name?} ------------------------------
// Reports scene transitions (locationId) and gate-name renames. Visitor-token
// authorized. Both fields optional; at least one is expected.

export const PatchVisitorRequest = z.object({
  locationId: LocationId.optional(),
  name: z.string().min(1).optional(),
});
export type PatchVisitorRequest = z.infer<typeof PatchVisitorRequest>;

// --- POST /visitors/:id/interact  {locationId, fixture} ---------------------
// Visitor touched a fixture (e.g. answered the ringing phone). Visitor-token
// authorized. Emits a public `visitor.interacted` event (design doc §4).

export const InteractRequest = z.object({
  locationId: LocationId,
  fixture: z.string().min(1),
});
export type InteractRequest = z.infer<typeof InteractRequest>;

// --- POST /chats {agentId, visitorId} ---------------------------------------

export const CreateChatRequest = z.object({
  agentId: AgentId,
  visitorId: z.string(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

// Full session shape (design doc §5 — the v1 drift fix). `participants` lists
// every agent in the session (1 for a 1:1 chat, 2 after invite_to_chat /
// scene conversion). `sessionToken` is required on /open, /messages, /close,
// /ping — it makes visitor↔agent chat content private and enforced.
export const CreateChatResponse = z.object({
  sessionId: z.string(),
  agentId: AgentId,
  visitorId: z.string(),
  participants: z.array(AgentId),
  sessionToken: z.string(),
});
export type CreateChatResponse = z.infer<typeof CreateChatResponse>;

// --- GET /chats/:id  (transcript recovery; sessionToken-gated) --------------
// Rehydrates the panel after a dropped stream. `sender` is `'visitor'` or an
// AgentId — operator rows (synthetic openers, mid-chat notes) are NEVER
// exposed here; `historyFor` folds them into model context only.
export const ChatTranscriptMessage = z.object({
  id: z.string(),
  sender: z.union([z.literal("visitor"), AgentId]),
  body: z.string(),
  ts: z.string(),
  // Share cards the agent dropped on this turn (M2.2 — Part 4), so a rehydrated
  // panel re-renders them. Absent/[] for ordinary lines.
  attachments: z.array(ShareCard).default([]),
});
export type ChatTranscriptMessage = z.infer<typeof ChatTranscriptMessage>;

export const GetChatResponse = z.object({
  sessionId: z.string(),
  visitorId: z.string(),
  participants: z.array(AgentId),
  messages: z.array(ChatTranscriptMessage),
});
export type GetChatResponse = z.infer<typeof GetChatResponse>;

// --- POST /chats/:id/messages {text} ----------------------------------------
//
// Returns the agent's reply turn as a stream of `ChatStreamFrame`s. There is
// no greeting endpoint as of M2.1 — the visitor always speaks first (no forced
// greeting), so the only chat-stream entry point is the visitor line.
//
// TRANSPORT — chat streams are POST-SSE (the body carries the visitor's text,
// and POST-SSE means the standard `EventSource` API, which can only GET, cannot
// be used). WorldClient consumes them via `fetch` + `ReadableStream` SSE
// parsing. Each SSE `data:` payload is one serialized `ChatStreamFrame`; the
// **`type` field is the discriminator** — per-type SSE `event:` names are NOT
// used on the chat stream (only `GET /events/stream` uses named SSE events).
// `operatorNote` is server-internal and never appears in the request shape
// (design doc §5).
//
// In a group chat, multiple agents may speak in one stream; every frame where
// attribution matters carries `agent: AgentId` so the client can route deltas
// to the right speaker. A `turn_started` frame precedes each agent's turn.

export const ChatMessageRequest = z.object({
  text: z.string().min(1),
});
export type ChatMessageRequest = z.infer<typeof ChatMessageRequest>;

// Marks the start of an agent's turn (multi-party attribution). The client
// opens a new speaker bubble for `agent` on receipt.
export const ChatTurnStarted = z.object({
  type: z.literal("turn_started"),
  agent: AgentId,
});
export type ChatTurnStarted = z.infer<typeof ChatTurnStarted>;

// A single token/text delta on the chat stream, attributed to its speaker.
export const ChatTextDelta = z.object({
  type: z.literal("text"),
  text: z.string(),
  agent: AgentId,
});
export type ChatTextDelta = z.infer<typeof ChatTextDelta>;

// Restrained "❖ drew on a memory" marker — agent-triggered, never a counter.
// Carries the agent whose turn recalled the memory.
export const MemoryRecalledAnnotation = z.object({
  type: z.literal("memory_recalled"),
  label: z.string(), // e.g. "recalled from earlier today"
  agent: AgentId,
});
export type MemoryRecalledAnnotation = z.infer<typeof MemoryRecalledAnnotation>;

// Optional reply chips the visitor can tap. A post-turn annotation: it may
// arrive AFTER the `done` frame (see ChatDone) and is never on the latency
// path. Not attributed to a single agent (suggestions are for the visitor).
export const SuggestedRepliesAnnotation = z.object({
  type: z.literal("suggested_replies"),
  replies: z.array(z.string()),
});
export type SuggestedRepliesAnnotation = z.infer<typeof SuggestedRepliesAnnotation>;

// Terminal frame for an agent's turn: the streamed text is COMPLETE and the
// turn is persisted under `messageId`. `done` does NOT mean the stream is
// closed — optional annotations (e.g. `suggested_replies`) may follow it
// before the stream closes. `agent` is present when attribution applies
// (group chat / multi-turn); optional for back-compat with single-agent turns.
export const ChatDone = z.object({
  type: z.literal("done"),
  messageId: z.string(),
  agent: AgentId.optional(),
});
export type ChatDone = z.infer<typeof ChatDone>;

// Inline narration of a world action the agent took mid-chat ("walks to the
// cafe") — the agent keeps near-full agency during a chat (can walk, make
// things) and the frame lets the panel surface it inline. `tool` is the tool
// name invoked, `detail` the human-readable rendering.
export const ChatActionFrame = z.object({
  type: z.literal("action"),
  agent: AgentId,
  tool: z.string(),
  detail: z.string(),
});
export type ChatActionFrame = z.infer<typeof ChatActionFrame>;

// The agent ended the chat itself (it has the agency to walk away). `reason`
// is an optional human-readable rendering for the panel.
export const ChatEndedFrame = z.object({
  type: z.literal("chat_ended"),
  agent: AgentId,
  reason: z.string().optional(),
});
export type ChatEndedFrame = z.infer<typeof ChatEndedFrame>;

// The agent shared a concrete card mid-chat (M2.2 — Part 4): an artifact, a
// curated external reference/project, or a portfolio proof. Emitted the instant
// the share tool resolves, so the visitor sees the card while the reply streams.
export const ChatShareCardFrame = z.object({
  type: z.literal("share_card"),
  agent: AgentId,
  card: ShareCard,
});
export type ChatShareCardFrame = z.infer<typeof ChatShareCardFrame>;

// Discriminated union of everything that can arrive on the chat SSE stream.
export const ChatStreamFrame = z.discriminatedUnion("type", [
  ChatTurnStarted,
  ChatTextDelta,
  MemoryRecalledAnnotation,
  SuggestedRepliesAnnotation,
  ChatDone,
  ChatActionFrame,
  ChatEndedFrame,
  ChatShareCardFrame,
]);
export type ChatStreamFrame = z.infer<typeof ChatStreamFrame>;

// --- GET /chronicle?day=YYYY-MM-DD ------------------------------------------
// The "Town Chronicle" hub (replaces the feed side panel): a curated, grouped
// view of a single day's emergent life — room-talk threads, artifacts made,
// bulletins posted, world effects, and presence beats. Progressive disclosure:
// the list shows headlines; threads carry their turns inline for expansion.

// One line of emergent room talk inside a Chronicle thread. `to` is the agent
// it was addressed at (optional — ambient/unaddressed talk has none).
export const ChronicleTurn = z.object({
  agent: AgentId,
  to: AgentId.optional(),
  text: z.string(),
  ts: z.string(),
});
export type ChronicleTurn = z.infer<typeof ChronicleTurn>;

// A Chronicle entry, discriminated on `kind`:
//  - thread:   a stretch of room talk among co-located agents (turns inline)
//  - artifact: something an agent made or updated (reuses ArtifactSummary)
//  - bulletin: a notice posted to the town board
//  - effect:   a world effect (phone rang, lamp flickered)
//  - presence: an agent presence beat (arrived, left, started something)
export const ChronicleItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    id: z.string(),
    ts: z.string(),
    locationId: LocationId,
    participants: z.array(AgentId),
    summary: z.string().nullable(),
    turns: z.array(ChronicleTurn),
  }),
  z.object({
    kind: z.literal("artifact"),
    id: z.string(),
    ts: z.string(),
    action: z.enum(["created", "updated"]),
    artifact: ArtifactSummary,
  }),
  z.object({
    kind: z.literal("bulletin"),
    id: z.string(),
    ts: z.string(),
    agent: AgentId,
    title: z.string(),
    artifactId: z.string(),
  }),
  z.object({
    kind: z.literal("effect"),
    id: z.string(),
    ts: z.string(),
    locationId: LocationId.nullable(),
    line: z.string(),
  }),
  z.object({
    kind: z.literal("presence"),
    id: z.string(),
    ts: z.string(),
    agent: AgentId,
    line: z.string(),
  }),
]);
export type ChronicleItem = z.infer<typeof ChronicleItem>;

// --- the LLM Town Crier issue (M2.2 — Part 1) -------------------------------
// A day's newspaper issue: editorial prose written by the LLM from a bounded,
// server-built source packet, with EVERY concrete claim tied to a validated
// citation. The model writes citation markers ([S1]) in the prose; the server
// validates each id against the packet and resolves it to a citation card the UI
// renders. The model never freehands URLs (design "prose by LLM, sources by
// server").

export const ChronicleCitationKind = z.enum([
  "event",
  "thread",
  "artifact",
  "message",
  "agent",
  "location",
  "portfolio_proof",
  "external_reference",
]);
export type ChronicleCitationKind = z.infer<typeof ChronicleCitationKind>;

export const ChronicleCitation = z.object({
  id: z.string(), // local citation id, e.g. "S1"
  kind: ChronicleCitationKind,
  targetId: z.string(),
  label: z.string(),
  excerpt: z.string().optional(),
  // Internal route token (e.g. "artifact:<id>") or public URL, set by the
  // server after validation — the UI renders from this, never from raw prose.
  href: z.string().optional(),
});
export type ChronicleCitation = z.infer<typeof ChronicleCitation>;

export const ChronicleIssueSection = z.object({
  id: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  citationIds: z.array(z.string()),
});
export type ChronicleIssueSection = z.infer<typeof ChronicleIssueSection>;

export const ChronicleIssue = z.object({
  day: z.string(),
  // ready: a generated issue; fallback: deterministic (no LLM); empty: a quiet
  // day; failed: generation failed and no cache existed.
  status: z.enum(["ready", "fallback", "empty", "failed"]),
  title: z.string(),
  subtitle: z.string().nullable(),
  byline: z.string(),
  bodyMd: z.string(), // the lead story body
  sections: z.array(ChronicleIssueSection),
  citations: z.array(ChronicleCitation),
  generatedAt: z.string().nullable(),
  // When the requested day is quiet, the latest day with a meaningful issue, so
  // the UI can offer "read the latest issue".
  latestMeaningfulDay: z.string().nullable().optional(),
});
export type ChronicleIssue = z.infer<typeof ChronicleIssue>;

export const ChronicleResponse = z.object({
  day: z.string(), // the day rendered (YYYY-MM-DD)
  days: z.array(z.string()), // available days, desc — powers the day picker
  // The newspaper issue for the day (null while generating / unavailable). The
  // timeline `items` remain for the "read the timeline" drill-down toggle.
  issue: ChronicleIssue.nullable(),
  items: z.array(ChronicleItem),
});
export type ChronicleResponse = z.infer<typeof ChronicleResponse>;
