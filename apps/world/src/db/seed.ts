// Seed the world: 6 locations (display name + agent-facing description +
// fixtures + adjacency) and the 5 agents (display names from apps/web's
// npc-configs, starting locations sensible per facet). Idempotent: upserts on
// the primary key so re-running is safe.

import { db, pool, schema } from "./client.js";

const { locations, agents } = schema;

// Adjacency is a small graph: the town square connects to every interior;
// interiors connect back to town (you walk through the square to reach others).
const LOCATIONS = [
  {
    id: "town",
    name: "Town Square",
    description:
      "The open square at the heart of town. A notice board stands by the fountain where anyone can post bulletins for everyone — agents and visitors — to read. Paths lead off to the office, library, workshop, cafe, and park.",
    fixtures: [
      { id: "notice board", kind: "bulletin_board", note: "Post bulletins here (gated to town).", actions: ["rustle"] },
      { id: "news stand", kind: "digest", note: "The Town Crier daily digest appears here." },
      { id: "fountain", kind: "decoration" },
    ],
    adjacency: ["office", "library", "workshop", "cafe", "park"],
  },
  {
    id: "office",
    name: "The Office",
    description:
      "A focused workspace with a desk and the outbox — the only desk in town with a line to the outside world. Mail to Thomas and capability requests go out from here.",
    fixtures: [
      { id: "outbox", kind: "mail", note: "email_thomas and request_capability are gated here." },
      { id: "desk", kind: "workstation" },
      { id: "phone", kind: "device", note: "The office phone. Ring it to summon a visitor's attention.", actions: ["ring"] },
    ],
    adjacency: ["town"],
  },
  {
    id: "library",
    name: "The Library",
    description:
      "Quiet shelves and a reading desk. Research notes are filed on the bookshelf; it's the place for deep reading and thinking.",
    fixtures: [
      { id: "bookshelf", kind: "artifact_shelf", note: "Research notes live here." },
      { id: "reading desk", kind: "workstation" },
      { id: "lamp", kind: "device", note: "The reading lamp. Flicker it for effect.", actions: ["flicker"] },
    ],
    adjacency: ["town"],
  },
  {
    id: "workshop",
    name: "The Workshop",
    description:
      "A maker's space cluttered with half-built things. A big monitor on the wall shows project logs and whatever is currently being shipped.",
    fixtures: [
      { id: "monitor", kind: "artifact_shelf", note: "Project logs are displayed here." },
      { id: "workbench", kind: "workstation" },
      { id: "lamp", kind: "device", note: "The work lamp. Flicker it for effect.", actions: ["flicker"] },
    ],
    adjacency: ["town"],
  },
  {
    id: "cafe",
    name: "The Cafe",
    description:
      "Warm light, coffee, and the press in the corner — where writing goes public. Blog posts are published from the cafe press.",
    fixtures: [
      { id: "press", kind: "publisher", note: "publish_blog_post is gated here." },
      { id: "corner table", kind: "workstation" },
      { id: "espresso machine", kind: "device", note: "The cafe espresso machine. Hiss it for ambiance.", actions: ["hiss"] },
    ],
    adjacency: ["town"],
  },
  {
    id: "park",
    name: "The Park",
    description:
      "Grass, trees, and — for reasons no one questions — a slightly ridiculous painted sign where fun lists and bits get pinned up. A red telephone box stands by the pavement at the south edge.",
    fixtures: [
      { id: "the dumb sign", kind: "artifact_shelf", note: "Fun lists / bits get pinned here. Hobby insisted." },
      { id: "bench", kind: "decoration" },
      {
        id: "payphone",
        kind: "device",
        note: "The park's red telephone box. Ring it and whoever's in the park — agent or visitor — hears it. (A visitor answering takes a while to reach you: their reply arrives as a world event, not instantly.)",
        actions: ["ring"],
      },
    ],
    adjacency: ["town"],
  },
] as const;

// Display names mirror apps/web/src/game/data/npc-configs.ts. Starting
// locations match each facet's home turf (plan §3.1 / §6 anchors).
const AGENTS = [
  { id: "career", displayName: "Career Thomas", locationId: "office", status: "settling in" },
  { id: "researcher", displayName: "Researcher Thomas", locationId: "library", status: "settling in" },
  { id: "builder", displayName: "Builder Thomas", locationId: "workshop", status: "settling in" },
  { id: "writer", displayName: "Writer Thomas", locationId: "cafe", status: "settling in" },
  { id: "hobby", displayName: "Hobby Thomas", locationId: "park", status: "settling in" },
] as const;

async function main() {
  for (const loc of LOCATIONS) {
    await db
      .insert(locations)
      .values({
        id: loc.id,
        name: loc.name,
        description: loc.description,
        fixtures: loc.fixtures,
        adjacency: loc.adjacency,
      })
      .onConflictDoUpdate({
        target: locations.id,
        set: {
          name: loc.name,
          description: loc.description,
          fixtures: loc.fixtures,
          adjacency: loc.adjacency,
        },
      });
  }
  console.log(`seeded ${LOCATIONS.length} locations`);

  for (const a of AGENTS) {
    await db
      .insert(agents)
      .values({
        id: a.id,
        displayName: a.displayName,
        locationId: a.locationId,
        status: a.status,
      })
      .onConflictDoUpdate({
        target: agents.id,
        // Never reset locationId/status on re-seed: the seed runs on every
        // deploy and must not teleport live agents back to their home spots.
        set: { displayName: a.displayName },
      });
  }
  console.log(`seeded ${AGENTS.length} agents`);

  await pool.end();
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
