// Seed the world: 6 locations (display name + agent-facing description +
// fixtures + adjacency) and the 5 agents (display names from apps/web's
// npc-configs, starting locations sensible per facet). Idempotent: upserts on
// the primary key so re-running is safe.

import { db, pool, schema } from "./client.js";
import { upsertReference } from "../engine/references.js";
import { upsertProof } from "../engine/portfolio.js";
import { REFERENCE_SEED, PROOF_SEED } from "./portfolio-content.js";
import { ZONES, LOCATION_KIND, defaultZone } from "../engine/zones.js";
import type { LocationId, ObjectPlacement } from "@town/contract";

const { locations, agents, worldObjects } = schema;

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

// --- world_objects derivation (MUD embodiment foundation) -------------------
// Materialize the existing LOCATIONS.fixtures into first-class world_objects
// rows, ADDITIVELY (the fixtures column stays seeded + authoritative for
// perception/use_fixture in this slice). The three maps below bind each known
// fixture to a library template, a seeded zone, and the existing hand-authored
// scene coordinates where known (so the renderer can later read placement from
// world_objects). Unknown => null. Keys are `<location>.<fixture id>`.

// FIXTURE → library.json template name (the asset-vocabulary bridge). Drawn from
// the hand-authored scene mappings; null where no sprite is pinned yet.
const FIXTURE_TEMPLATE: Record<string, string | null> = {
  "town.notice board": "blue-info-sign-board",
  "town.news stand": null,
  "town.fountain": null,
  "office.outbox": null,
  "office.desk": null,
  "office.phone": "rotary-phone-red",
  "library.bookshelf": null,
  "library.reading desk": null,
  "library.lamp": "table-lamp-beige-lit",
  "workshop.monitor": null,
  "workshop.workbench": null,
  "workshop.lamp": "table-lamp-beige-lit",
  "cafe.press": null,
  "cafe.corner table": null,
  "cafe.espresso machine": null,
  "park.the dumb sign": null,
  "park.bench": "wooden-park-bench-side",
  "park.payphone": "phone-booth-red",
};

// FIXTURE → seeded zone id. Falls back to `<location>.center`.
const FIXTURE_ZONE: Record<string, string> = {
  "town.notice board": "town.plaza-board",
  "town.news stand": "town.news-corner",
  "town.fountain": "town.fountain-edge",
  "office.outbox": "office.outbox-nook",
  "office.desk": "office.desk",
  "office.phone": "office.desk",
  "library.bookshelf": "library.stacks",
  "library.reading desk": "library.desk",
  "library.lamp": "library.reading-nook",
  "workshop.monitor": "workshop.monitor-corner",
  "workshop.workbench": "workshop.bench-area",
  "workshop.lamp": "workshop.bench-area",
  "cafe.press": "cafe.press-corner",
  "cafe.corner table": "cafe.tables",
  "cafe.espresso machine": "cafe.counter",
  "park.the dumb sign": "park.the-sign",
  "park.bench": "park.bench-area",
  "park.payphone": "park.phone-box",
};

// FIXTURE → existing hand-authored renderer coordinates (Town scene), where
// known. Pre-fills placement so a later cutover can drive the renderer from
// world_objects; null where coordinates aren't pinned yet.
const FIXTURE_PLACEMENT: Record<string, ObjectPlacement | null> = {
  "town.notice board": { scene: "Town", x: 396, y: 320 },
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function seedWorldObjects() {
  let count = 0;
  for (const loc of LOCATIONS) {
    const fixtures = loc.fixtures as ReadonlyArray<{
      id: string;
      kind?: string;
      note?: string;
      actions?: readonly string[];
    }>;
    for (const f of fixtures) {
      const key = `${loc.id}.${f.id}`;
      const id = `${loc.id}.${slugify(f.id)}`;
      const zone = FIXTURE_ZONE[key] ?? defaultZone(loc.id as LocationId);
      const template = FIXTURE_TEMPLATE[key] ?? null;
      const placement = FIXTURE_PLACEMENT[key] ?? null;
      await db
        .insert(worldObjects)
        .values({
          id,
          template,
          // displayName is the EXACT fixture id string so perception is unchanged.
          displayName: f.id,
          locationId: loc.id,
          zone,
          placement,
          kind: f.kind ?? null,
          description: f.note ?? null,
          affordances: [...(f.actions ?? [])],
          movable: false,
          ownerAgentId: null,
        })
        .onConflictDoUpdate({
          target: worldObjects.id,
          // CRITICAL idempotency rule (mirrors agents.locationId): refresh only
          // the seed-derived descriptive fields. NEVER overwrite state,
          // attachedArtifactIds, notes, or ownerAgentId — once an agent mutates
          // an object or owns it, a re-seed must not clobber that living state.
          set: {
            displayName: f.id,
            kind: f.kind ?? null,
            description: f.note ?? null,
            affordances: [...(f.actions ?? [])],
            zone,
            template,
            placement,
            updatedAt: new Date(),
          },
        });
      count++;
    }
  }
  console.log(`seeded ${count} world_objects`);
}

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
        zones: ZONES[loc.id as LocationId] ?? [],
        kind: LOCATION_KIND[loc.id as LocationId] ?? null,
      })
      .onConflictDoUpdate({
        target: locations.id,
        set: {
          name: loc.name,
          description: loc.description,
          fixtures: loc.fixtures,
          adjacency: loc.adjacency,
          zones: ZONES[loc.id as LocationId] ?? [],
          kind: LOCATION_KIND[loc.id as LocationId] ?? null,
        },
      });
  }
  console.log(`seeded ${LOCATIONS.length} locations`);

  // Shadow-build the canonical object graph from the same fixtures (additive).
  await seedWorldObjects();

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

  // M2.2: curated portfolio catalog (external references + proof cards). Upserts
  // by id, so the curated content is the source of truth on every deploy; never
  // deletes rows not in the seed.
  for (const r of REFERENCE_SEED) await upsertReference(r);
  for (const p of PROOF_SEED) await upsertProof(p);
  console.log(`seeded ${REFERENCE_SEED.length} references, ${PROOF_SEED.length} proofs`);

  await pool.end();
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
