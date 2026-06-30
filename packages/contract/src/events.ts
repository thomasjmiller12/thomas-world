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
  // Phase C (space addressing): a semantic zone ID within `to` (e.g.
  // "park.bench-area") the agent is walking toward, when known. The server
  // ships only the WORD — never pixels; the frontend resolves it to a point
  // via its own zone-bounds table (mirrors how LOCATION_ANCHORS already
  // works). Absent/unresolvable just means "no specific spot" (room anchor).
  targetZone: z.string().nullable().optional(),
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
  // Optional addressing for emergent room talk aimed at a specific agent.
  to: AgentId.optional(),
});

/** @deprecated no longer emitted as of M2.1 — paced scenes removed; kept so historical world_events rows parse */
export const ConversationStartedPayload = z.object({
  conversationId: z.string(),
  location: LocationId,
  participants: z.array(AgentId),
});

/** @deprecated no longer emitted as of M2.1 — paced scenes removed; kept so historical world_events rows parse */
export const ConversationTurnPayload = z.object({
  conversationId: z.string(),
  agent: AgentId,
  text: z.string(),
});

/** @deprecated no longer emitted as of M2.1 — paced scenes removed; kept so historical world_events rows parse */
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

// Public presence only (design §3.3: chat content is private to the visitor) —
// the server intentionally omits sessionId on the public stream.
export const ChatStartedPayload = z.object({
  agent: AgentId,
  visitorId: z.string(),
  sessionId: z.string().optional(),
});

// Same presence-only rule as ChatStartedPayload.
export const ChatEndedPayload = z.object({
  agent: AgentId,
  visitorId: z.string(),
  sessionId: z.string().optional(),
});

// --- M2 event payloads (design doc §5) -------------------------------------

// A visitor (logical body) moved between locations. `from` null => first
// placement (gate → town). Public: agents at `to` perceive the arrival.
export const VisitorMovedPayload = z.object({
  visitorId: z.string(),
  name: z.string(),
  from: LocationId.nullable(),
  to: LocationId,
});

// A visitor touched a fixture (answered the phone, etc.). Public; routes to
// an operator note mid-chat when the triggering agent shares a session.
export const VisitorInteractedPayload = z.object({
  visitorId: z.string(),
  name: z.string(),
  location: LocationId,
  fixture: z.string(),
});

// An agent touched the *set* via `use_fixture` (phone rings, lamp flickers).
// Public; the frontend materializes shake/sound/glow + a visitor affordance.
// `agent` optional: an effect may be ambient/system-triggered.
export const WorldEffectPayload = z.object({
  location: LocationId,
  fixture: z.string(),
  effect: z.string(),
  agent: AgentId.optional(),
});

// A second agent joined a chat session (invite_to_chat / scene conversion).
// `sessionId` carried only on private/feed surfaces (presence-only in public).
export const ChatJoinedPayload = z.object({
  sessionId: z.string().optional(),
  agent: AgentId,
});

/** @deprecated no longer emitted as of M2.1 — paced scenes removed; kept so historical world_events rows parse */
// A paced scene was converted to a group chat (visitor interjected). Public;
// no session linkage exposed (the chat is private to the interjecting visitor).
export const ConversationConvertedPayload = z.object({
  conversationId: z.string(),
});

export const WorldTimePayload = z.object({
  phase: DayPhase, // day/night tint
});

// --- world-object events (MUD embodiment foundation) ------------------------
// Five additive types for the canonical object graph. `object.noted` is the
// only one EMITTED in this slice (by leave_note); the other four are
// forward-ready render arms (their emission lands with the control-verb /
// cutover slices). All visibility "location".

// An agent placed a new object instance in a zone.
export const ObjectCreatedPayload = z.object({
  objectId: z.string(),
  agent: AgentId,
  location: LocationId,
  zone: z.string(),
  template: z.string().nullable(),
  displayName: z.string(),
});

// An agent moved an existing object between zones.
export const ObjectMovedPayload = z.object({
  objectId: z.string(),
  agent: AgentId,
  location: LocationId,
  fromZone: z.string(),
  toZone: z.string(),
});

// An object's visible state changed (supersedes world.effect semantically;
// world.effect keeps emitting in this slice). `agent` null => ambient/system.
export const ObjectStateChangedPayload = z.object({
  objectId: z.string(),
  agent: AgentId.nullable(),
  location: LocationId,
  effect: z.string(),
  state: z.record(z.string(), z.unknown()).optional(),
});

// An artifact was attached to an object ("a note appears on the shelf").
export const ObjectAttachedPayload = z.object({
  objectId: z.string(),
  artifactId: z.string(),
  agent: AgentId,
  location: LocationId,
  kind: ArtifactKind,
  title: z.string(),
});

// An agent jotted a short note on an object or zone (emitted by leave_note).
// `objectId` null when the note is anchored to a bare zone instead.
export const ObjectNotedPayload = z.object({
  objectId: z.string().nullable(),
  zone: z.string().optional(),
  agent: AgentId,
  location: LocationId,
  text: z.string(),
});

// --- director/effect protocol (Phase A) -------------------------------------
// A `screen`-surface beat crossed the glass onto the visitor's client (popup
// card, emote, etc.). `surface:"object"` beats ride the existing world.effect +
// object.state_changed paths instead; this type carries only screen beats.
// `agent` null => ambient/system. `visitorId` null => room-wide (every
// co-located visitor renders it); a non-null id directs the beat at one visitor.
export const WorldBeatPayload = z.object({
  beat: z.string(),
  agent: AgentId.nullable(),
  location: LocationId,
  objectId: z.string().nullable(),     // anchor object if any
  visitorId: z.string().nullable(),    // directed beats: the target visitor; null = whole room
  params: z.record(z.string(), z.unknown()),
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
  z.object({ ...envelopeBase, type: z.literal("visitor.moved"), payload: VisitorMovedPayload }),
  z.object({ ...envelopeBase, type: z.literal("visitor.interacted"), payload: VisitorInteractedPayload }),
  z.object({ ...envelopeBase, type: z.literal("world.effect"), payload: WorldEffectPayload }),
  z.object({ ...envelopeBase, type: z.literal("chat.started"), payload: ChatStartedPayload }),
  z.object({ ...envelopeBase, type: z.literal("chat.ended"), payload: ChatEndedPayload }),
  z.object({ ...envelopeBase, type: z.literal("chat.joined"), payload: ChatJoinedPayload }),
  z.object({ ...envelopeBase, type: z.literal("conversation.converted"), payload: ConversationConvertedPayload }),
  z.object({ ...envelopeBase, type: z.literal("world.time"), payload: WorldTimePayload }),
  z.object({ ...envelopeBase, type: z.literal("object.created"), payload: ObjectCreatedPayload }),
  z.object({ ...envelopeBase, type: z.literal("object.moved"), payload: ObjectMovedPayload }),
  z.object({ ...envelopeBase, type: z.literal("object.state_changed"), payload: ObjectStateChangedPayload }),
  z.object({ ...envelopeBase, type: z.literal("object.attached"), payload: ObjectAttachedPayload }),
  z.object({ ...envelopeBase, type: z.literal("object.noted"), payload: ObjectNotedPayload }),
  z.object({ ...envelopeBase, type: z.literal("world.beat"), payload: WorldBeatPayload }),
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
  "visitor.moved",
  "visitor.interacted",
  "world.effect",
  "chat.started",
  "chat.ended",
  "chat.joined",
  "conversation.converted",
  "world.time",
  "object.created",
  "object.moved",
  "object.state_changed",
  "object.attached",
  "object.noted",
  "world.beat",
] as const;
export const WorldEventType = z.enum(worldEventTypes);
export type WorldEventType = z.infer<typeof WorldEventType>;
