import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ZONES } from "./zones.js";
import type { SemanticZone } from "@town/contract";

// Drift guard for two hand-copy problems flagged in CLAUDE.md's Phase C notes:
//
// (1) Zone bounds are hand-maintained in TWO places —
//       server:   apps/world/src/engine/zones.ts        ZONES[...].bounds
//       frontend: apps/web/src/game/data/zone-bounds.ts  ZONE_BOUNDS
//     The wire deliberately carries only a zone ID (agent.moved.targetZone),
//     never pixels — the frontend keeps its OWN copy of the rect a zone
//     resolves to (see that file's own header comment). Nothing has ever
//     caught the two silently disagreeing: an agent still correctly believes
//     it's "at the workbench", but its SPRITE walks to whatever stale pixel
//     the frontend copy has for that id.
//
// (2) AGENT_LABELS (a `Record<AgentId, string>` mapping e.g. "career" →
//     "Career") is defined verbatim in THREE files — engine/chronicle.ts,
//     engine/chronicle-issue.ts, and runtime/loop.ts — rather than imported
//     from one place.
//
// This test does NOT unify the files (that split is an intentional
// architectural decision, not an oversight) — it only makes drift between the
// copies impossible to ship unnoticed. All non-server files are read as TEXT
// and parsed with a small regex rather than imported, because:
//   - apps/web is a separate Next.js project with its own path aliases/
//     tsconfig that apps/world's module graph doesn't resolve, and
//   - runtime/loop.ts's AGENT_LABELS isn't exported, and this housekeeping
//     pass is explicitly not permitted to edit runtime/loop.ts to add one.

const here = dirname(fileURLToPath(import.meta.url));
const webZoneBoundsPath = resolve(here, "../../../web/src/game/data/zone-bounds.ts");
const chroniclePath = resolve(here, "./chronicle.ts");
const chronicleIssuePath = resolve(here, "./chronicle-issue.ts");
const loopPath = resolve(here, "../runtime/loop.ts");

interface Bounds {
  scene: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Parse `"zone.id": { scene: "X", x: N, y: N, w: N, h: N },` entries out of the
// frontend's ZONE_BOUNDS object literal (apps/web/src/game/data/zone-bounds.ts).
function parseFrontendZoneBounds(source: string): Record<string, Bounds> {
  const out: Record<string, Bounds> = {};
  const re =
    /"([\w.-]+)":\s*\{\s*scene:\s*"([^"]+)",\s*x:\s*(-?\d+),\s*y:\s*(-?\d+),\s*w:\s*(-?\d+),\s*h:\s*(-?\d+)\s*\}/g;
  for (const m of source.matchAll(re)) {
    const [, id, scene, x, y, w, h] = m;
    out[id] = { scene, x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
  }
  return out;
}

// Parse the `const AGENT_LABELS: Record<AgentId, string> = { ... };` object
// literal out of any of the three files that define it verbatim.
function parseAgentLabels(source: string, path: string): Record<string, string> {
  const block = source.match(/AGENT_LABELS:\s*Record<AgentId,\s*string>\s*=\s*\{([\s\S]*?)\};/);
  if (!block) {
    throw new Error(`could not find an "AGENT_LABELS: Record<AgentId, string> = {...}" literal in ${path}`);
  }
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// Flatten the server's per-location zone registry into id → bounds, matching
// the frontend table's shape.
function serverZoneBounds(): Record<string, Bounds> {
  const out: Record<string, Bounds> = {};
  for (const zones of Object.values(ZONES) as SemanticZone[][]) {
    for (const z of zones) {
      if (z.bounds) out[z.id] = z.bounds;
    }
  }
  return out;
}

describe("zone bounds: server (zones.ts) vs frontend (zone-bounds.ts) drift", () => {
  const server = serverZoneBounds();
  const frontend = parseFrontendZoneBounds(readFileSync(webZoneBoundsPath, "utf8"));

  it("every server zone id has a frontend counterpart", () => {
    const missing = Object.keys(server).filter((id) => !(id in frontend));
    expect(
      missing,
      `zone id(s) defined in apps/world/src/engine/zones.ts but MISSING from ` +
        `apps/web/src/game/data/zone-bounds.ts: ${missing.join(", ") || "(none — see array above)"}`,
    ).toEqual([]);
  });

  it("every frontend zone id has a server counterpart", () => {
    const missing = Object.keys(frontend).filter((id) => !(id in server));
    expect(
      missing,
      `zone id(s) defined in apps/web/src/game/data/zone-bounds.ts but MISSING ` +
        `from apps/world/src/engine/zones.ts: ${missing.join(", ") || "(none — see array above)"}`,
    ).toEqual([]);
  });

  it("bounds (scene, x, y, w, h) match exactly for every shared zone id", () => {
    const mismatches: string[] = [];
    for (const id of Object.keys(server)) {
      const s = server[id];
      const f = frontend[id];
      if (!f) continue; // reported by the "missing" test above, not here
      for (const key of ["scene", "x", "y", "w", "h"] as const) {
        if (s[key] !== f[key]) {
          mismatches.push(
            `zone "${id}".${key}: server(zones.ts)=${JSON.stringify(s[key])} vs ` +
              `frontend(zone-bounds.ts)=${JSON.stringify(f[key])}`,
          );
        }
      }
    }
    expect(mismatches, `zone bounds drift found:\n${mismatches.join("\n")}`).toEqual([]);
  });
});

describe("AGENT_LABELS drift across its three hand-maintained copies", () => {
  const sources = [
    { file: "engine/chronicle.ts", labels: parseAgentLabels(readFileSync(chroniclePath, "utf8"), chroniclePath) },
    {
      file: "engine/chronicle-issue.ts",
      labels: parseAgentLabels(readFileSync(chronicleIssuePath, "utf8"), chronicleIssuePath),
    },
    { file: "runtime/loop.ts", labels: parseAgentLabels(readFileSync(loopPath, "utf8"), loopPath) },
  ];

  it("all three copies agree on every agent's label", () => {
    const allIds = new Set<string>();
    for (const s of sources) for (const id of Object.keys(s.labels)) allIds.add(id);

    const mismatches: string[] = [];
    for (const id of allIds) {
      const values = sources.map((s) => s.labels[id]);
      if (new Set(values).size > 1) {
        const detail = sources.map((s) => `${s.file}=${JSON.stringify(s.labels[id])}`).join(", ");
        mismatches.push(`AGENT_LABELS["${id}"] disagrees: ${detail}`);
      }
    }
    expect(mismatches, `AGENT_LABELS drift found:\n${mismatches.join("\n")}`).toEqual([]);
  });
});
