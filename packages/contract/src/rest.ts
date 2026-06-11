import { z } from "zod";
import { AgentId, LocationId } from "./ids.js";
import { ArtifactKind } from "./artifacts.js";
import { WorldEvent } from "./events.js";

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
  busy: z.boolean(),
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

export const SnapshotResponse = z.object({
  agents: z.array(AgentStatus),
  conversations: z.array(ActiveConversation),
  recentEvents: z.array(WorldEvent),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;

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
});
export type FeedItem = z.infer<typeof FeedItem>;

export const FeedResponse = z.object({
  items: z.array(FeedItem),
  nextCursor: z.string().nullable(),
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
});
export type CreateVisitorResponse = z.infer<typeof CreateVisitorResponse>;

// --- POST /chats {agentId, visitorId} ---------------------------------------

export const CreateChatRequest = z.object({
  agentId: AgentId,
  visitorId: z.string(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

export const CreateChatResponse = z.object({
  sessionId: z.string(),
  agentId: AgentId,
  visitorId: z.string(),
});
export type CreateChatResponse = z.infer<typeof CreateChatResponse>;

// --- POST /chats/:id/messages {text} ----------------------------------------
// Returns an SSE stream of response tokens. The annotations below are the
// optional out-of-band markers the design mocks expect, emitted on the stream
// alongside the text deltas.

export const ChatMessageRequest = z.object({
  text: z.string().min(1),
});
export type ChatMessageRequest = z.infer<typeof ChatMessageRequest>;

// Restrained "❖ drew on a memory" marker — agent-triggered, never a counter.
export const MemoryRecalledAnnotation = z.object({
  type: z.literal("memory_recalled"),
  label: z.string(), // e.g. "recalled from earlier today"
});
export type MemoryRecalledAnnotation = z.infer<typeof MemoryRecalledAnnotation>;

// Optional reply chips the visitor can tap.
export const SuggestedRepliesAnnotation = z.object({
  type: z.literal("suggested_replies"),
  replies: z.array(z.string()),
});
export type SuggestedRepliesAnnotation = z.infer<typeof SuggestedRepliesAnnotation>;

// A single token/text delta on the chat stream.
export const ChatTextDelta = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type ChatTextDelta = z.infer<typeof ChatTextDelta>;

// Terminal frame; carries the persisted message id once the turn completes.
export const ChatDone = z.object({
  type: z.literal("done"),
  messageId: z.string(),
});
export type ChatDone = z.infer<typeof ChatDone>;

// Discriminated union of everything that can arrive on the chat SSE stream.
export const ChatStreamFrame = z.discriminatedUnion("type", [
  ChatTextDelta,
  MemoryRecalledAnnotation,
  SuggestedRepliesAnnotation,
  ChatDone,
]);
export type ChatStreamFrame = z.infer<typeof ChatStreamFrame>;
