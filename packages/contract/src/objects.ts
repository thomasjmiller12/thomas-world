import { z } from "zod";
import { AgentId, LocationId } from "./ids.js";

// The MUD world model (world-embodiment foundation). A `WorldObject` is a
// first-class, agent-legible, agent-mutable furniture instance — the successor
// to today's free-string `locations.fixtures`. Agents reason over named objects
// in named ZONES (text-rooms-objects-verbs, the representation an LLM plays
// fluently); the renderer is a downstream subscriber. This slice is purely
// ADDITIVE: world_objects is shadow-built alongside the still-live fixtures
// column, so perception/tools/behavior are unchanged until a later cutover.

// A renderer hint. The agent NEVER sees or sets pixels — the frontend or the
// offline-render validation layer fills this. Null means "renderer, pick a spot
// in the zone."
export const ObjectPlacement = z.object({
  scene: z.string(),
  x: z.number(),
  y: z.number(),
  layer: z.number().optional(),
  origin: z.tuple([z.number(), z.number()]).optional(),
});
export type ObjectPlacement = z.infer<typeof ObjectPlacement>;

// A small, loosely-typed state bag, e.g. { on?: boolean, open?: boolean }.
// Rendered in perception ONLY when non-default (silence on default is the key
// anti-game-y rule).
export const WorldObjectState = z.record(z.string(), z.unknown());
export type WorldObjectState = z.infer<typeof WorldObjectState>;

// A short persistent in-world note jotted on an object or zone (leave_note).
export const ObjectNote = z.object({
  agent: AgentId,
  text: z.string(),
  ts: z.string(), // ISO 8601
});
export type ObjectNote = z.infer<typeof ObjectNote>;

export const WorldObject = z.object({
  // Stable slug `<location>.<slug>` (e.g. "library.bookshelf"). Human-stable so
  // the seed is idempotent and the agent can reference it.
  id: z.string(),
  // A library.json object NAME (the bridge to the 648-asset vocabulary).
  // Nullable: an abstract object can exist before the renderer picks a sprite.
  template: z.string().nullable(),
  // Agent-facing label ("the notice board").
  displayName: z.string(),
  locationId: LocationId,
  // The SEMANTIC anchor, validated against the zone registry (e.g.
  // "workshop.north-wall"). Never pixels.
  zone: z.string(),
  // Renderer hint, filled by the frontend/validation layer; null => pick a spot.
  placement: ObjectPlacement.nullable(),
  state: WorldObjectState,
  // The verb whitelist (successor to FixtureDef.actions). Empty = decorative.
  affordances: z.array(z.string()),
  // Carries forward FixtureDef.kind (bulletin_board, device, artifact_shelf…).
  kind: z.string().nullable(),
  // The "note on the shelf" link; denormalized for fast read.
  attachedArtifactIds: z.array(z.string()),
  // Short persistent notes jotted here by agents.
  notes: z.array(ObjectNote),
  // Who placed/owns it. Null => town commons (seeded fixtures).
  ownerAgentId: AgentId.nullable(),
  // Agent-facing prose, carried from FixtureDef.note.
  description: z.string().nullable(),
  // Seeded fixtures are immovable; agent-placed objects default movable.
  movable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorldObject = z.infer<typeof WorldObject>;

// A named sub-region of a location the agent addresses in words. Zone → pixel
// coordinates is a frontend/validation concern; the server stores only the id.
export const SemanticZone = z.object({
  id: z.string(), // e.g. "workshop.north-wall"
  label: z.string(), // "the north wall"
  bounds: z
    .object({
      scene: z.string(),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
});
export type SemanticZone = z.infer<typeof SemanticZone>;
