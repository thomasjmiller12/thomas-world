// @town/contract — shared zod schemas + types (event taxonomy, REST shapes,
// agent/location IDs) imported by both apps/web and apps/world. The world
// server is the source of truth at runtime; this package is the source of
// truth for the SHAPES that cross the wire.

export * from "./ids.js";
export * from "./artifacts.js";
export * from "./events.js";
export * from "./rest.js";
