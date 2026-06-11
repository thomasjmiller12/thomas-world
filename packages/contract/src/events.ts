import { z } from "zod";
import { AgentId, LocationId, DayPhase, Visibility } from "./ids.js";
import { ArtifactKind } from "./artifacts.js";

// The world-event taxonomy (plan §5). This is BOTH the SSE event stream the
// frontend consumes AND the `world_events.type` enum — one source of truth.
// Each event is a discriminated union member keyed on `type`; the envelope
// wraps a payload with routing/scoping metadata.

// --- payload shapes (one per event type) -----------------------------------

export const AgentMovedPayload = z.object({
  agent: AgentId,
  from: LocationId,
  to: LocationId,
});

export const AgentActivityPayload = z.object({
  agent: AgentId,
  activity: z.string(), // "working on X", "reading Y"
});

export const AgentThoughtPayload = z.object({
  agent: AgentId,
  text: z.string(), // public-safe thoughts → bubbles
});

export const AgentSpokePayload = z.object({
  agent: AgentId,
  location: LocationId,
  text: z.string(), // ambient speech, overheard
});

export const ConversationStartedPayload = z.object({
  conversationId: z.string(),
  location: LocationId,
  participants: z.array(AgentId),
});

export const ConversationTurnPayload = z.object({
  conversationId: z.string(),
  agent: AgentId,
  text: z.string(),
});

export const ConversationEndedPayload = z.object({
  conversationId: z.string(),
  participants: z.array(AgentId),
});

// Headline only; body fetched via GET /messages. `to` null => broadcast.
export const MessageSentPayload = z.object({
  from: AgentId,
  to: AgentId.nullable(),
  broadcast: z.boolean(),
});

export const ArtifactCreatedPayload = z.object({
  artifactId: z.string(),
  agent: AgentId,
  kind: ArtifactKind,
  title: z.string(),
  location: LocationId.nullable(),
  fixture: z.string().nullable(),
});

export const ArtifactUpdatedPayload = z.object({
  artifactId: z.string(),
  agent: AgentId,
  kind: ArtifactKind,
  title: z.string(),
  location: LocationId.nullable(),
  fixture: z.string().nullable(),
});

export const BulletinPostedPayload = z.object({
  artifactId: z.string(),
  agent: AgentId,
  title: z.string(),
});

export const CapabilityRequestedPayload = z.object({
  agent: AgentId,
  summary: z.string(), // the meta-layer flex surface
});

export const VisitorArrivedPayload = z.object({
  visitorId: z.string(),
  name: z.string(),
});

export const VisitorLeftPayload = z.object({
  visitorId: z.string(),
  name: z.string(),
});

export const ChatStartedPayload = z.object({
  agent: AgentId,
  visitorId: z.string(),
  sessionId: z.string(),
});

export const ChatEndedPayload = z.object({
  agent: AgentId,
  visitorId: z.string(),
  sessionId: z.string(),
});

export const WorldTimePayload = z.object({
  phase: DayPhase, // day/night tint
});

// --- discriminated union ----------------------------------------------------

// Envelope fields shared by every event. `payload` is attached per-member
// below so the discriminated union narrows it precisely.
const envelopeBase = {
  id: z.string(),
  ts: z.string(), // ISO 8601
  agentId: AgentId.nullable().optional(),
  locationId: LocationId.nullable().optional(),
  visitorId: z.string().nullable().optional(),
  visibility: Visibility,
};

export const WorldEvent = z.discriminatedUnion("type", [
  z.object({ ...envelopeBase, type: z.literal("agent.moved"), payload: AgentMovedPayload }),
  z.object({ ...envelopeBase, type: z.literal("agent.activity"), payload: AgentActivityPayload }),
  z.object({ ...envelopeBase, type: z.literal("agent.thought"), payload: AgentThoughtPayload }),
  z.object({ ...envelopeBase, type: z.literal("agent.spoke"), payload: AgentSpokePayload }),
  z.object({ ...envelopeBase, type: z.literal("conversation.started"), payload: ConversationStartedPayload }),
  z.object({ ...envelopeBase, type: z.literal("conversation.turn"), payload: ConversationTurnPayload }),
  z.object({ ...envelopeBase, type: z.literal("conversation.ended"), payload: ConversationEndedPayload }),
  z.object({ ...envelopeBase, type: z.literal("message.sent"), payload: MessageSentPayload }),
  z.object({ ...envelopeBase, type: z.literal("artifact.created"), payload: ArtifactCreatedPayload }),
  z.object({ ...envelopeBase, type: z.literal("artifact.updated"), payload: ArtifactUpdatedPayload }),
  z.object({ ...envelopeBase, type: z.literal("bulletin.posted"), payload: BulletinPostedPayload }),
  z.object({ ...envelopeBase, type: z.literal("capability.requested"), payload: CapabilityRequestedPayload }),
  z.object({ ...envelopeBase, type: z.literal("visitor.arrived"), payload: VisitorArrivedPayload }),
  z.object({ ...envelopeBase, type: z.literal("visitor.left"), payload: VisitorLeftPayload }),
  z.object({ ...envelopeBase, type: z.literal("chat.started"), payload: ChatStartedPayload }),
  z.object({ ...envelopeBase, type: z.literal("chat.ended"), payload: ChatEndedPayload }),
  z.object({ ...envelopeBase, type: z.literal("world.time"), payload: WorldTimePayload }),
]);
export type WorldEvent = z.infer<typeof WorldEvent>;

// The bare `type` enum, handy for SQL column checks and exhaustive switches.
export const worldEventTypes = [
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
export const WorldEventType = z.enum(worldEventTypes);
export type WorldEventType = z.infer<typeof WorldEventType>;
