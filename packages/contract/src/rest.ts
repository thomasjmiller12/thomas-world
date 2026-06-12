import { z } from "zod";
import { AgentId, LocationId, DayPhase } from "./ids.js";
import { ArtifactKind } from "./artifacts.js";
import { WorldEvent, WorldEventType } from "./events.js";

// REST request/response shapes for every endpoint in plan §5. Inferred TS
// types are exported alongside each schema. Both apps import these; the typed
// WorldClient on the frontend is built from them.

// --- shared resource entities ----------------------------------------------

// What an agent is currently engaged in (design doc §3.2). One body, one
// conversation: an agent is either in a `chat` (with a visitor and maybe a
// second agent) or a `scene` (agent↔agent). `with` lists the co-participants
// — other agents by id, plus the literal `'visitor'` when a visitor is present.
// Absent => unengaged. `busy` below is the derived boolean (`engagement != null`).
export const AgentEngagement = z.object({
  kind: z.enum(["chat", "scene"]),
  with: z.array(z.union([AgentId, z.literal("visitor")])),
});
export type AgentEngagement = z.infer<typeof AgentEngagement>;

export const AgentStatus = z.object({
  id: AgentId,
  displayName: z.string(),
  locationId: LocationId,
  status: z.string(), // free-form: "working", "sleeping (budget)", "in conversation"
  activity: z.string().nullable(),
  // Derived: true iff `engagement` is present. Kept for back-compat with
  // surfaces that only need the boolean.
  busy: z.boolean(),
  engagement: AgentEngagement.optional(),
  lastTickAt: z.string().nullable(), // ISO 8601
});
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ActiveConversation = z.object({
  id: z.string(),
  locationId: LocationId,
  participantIds: z.array(AgentId),
  startedAt: z.string(),
});
export type ActiveConversation = z.infer<typeof ActiveConversation>;

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
  conversations: z.array(ActiveConversation),
  recentEvents: z.array(WorldEvent),
  world: WorldState,
});
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;

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
});
export type ChatTranscriptMessage = z.infer<typeof ChatTranscriptMessage>;

export const GetChatResponse = z.object({
  sessionId: z.string(),
  visitorId: z.string(),
  participants: z.array(AgentId),
  messages: z.array(ChatTranscriptMessage),
});
export type GetChatResponse = z.infer<typeof GetChatResponse>;

// --- POST /conversations/:id/join  {visitorId} ------------------------------
// Visitor interjects into a live agent↔agent scene (design doc §3.3a). The
// scene converts to a group chat with both agents as participants and the
// scene turns seeded as labeled context. Returns the new session (same shape
// as CreateChatResponse). On a lost race (another visitor interjected first)
// or a non-joinable scene, the server responds 409 — the client degrades to
// listen-in.
export const JoinConversationRequest = z.object({
  visitorId: z.string(),
});
export type JoinConversationRequest = z.infer<typeof JoinConversationRequest>;

export const JoinConversationResponse = CreateChatResponse;
export type JoinConversationResponse = z.infer<typeof JoinConversationResponse>;

// --- POST /chats/:id/messages {text}  AND  POST /chats/:id/open -------------
//
// Both return the agent's turn as a stream of `ChatStreamFrame`s. `/open`
// streams the agent-initiated greeting; `/messages` streams the reply to a
// visitor line.
//
// TRANSPORT — chat streams are POST-SSE (the body carries the visitor's text /
// the open trigger, and POST-SSE means the standard `EventSource` API, which
// can only GET, cannot be used). WorldClient consumes them via `fetch` +
// `ReadableStream` SSE parsing. Each SSE `data:` payload is one serialized
// `ChatStreamFrame`; the **`type` field is the discriminator** — per-type SSE
// `event:` names are NOT used on the chat stream (only `GET /events/stream`
// uses named SSE events). `operatorNote` is server-internal and never appears
// in the request shape (design doc §5).
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

// Discriminated union of everything that can arrive on the chat SSE stream.
export const ChatStreamFrame = z.discriminatedUnion("type", [
  ChatTurnStarted,
  ChatTextDelta,
  MemoryRecalledAnnotation,
  SuggestedRepliesAnnotation,
  ChatDone,
]);
export type ChatStreamFrame = z.infer<typeof ChatStreamFrame>;
