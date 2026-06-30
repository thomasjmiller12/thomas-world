import { describe, it, expect, beforeEach, vi } from "vitest";

// engine/agents.ts moveAgent tests — an in-memory mock of the one row this
// touches (agents) + the events table, mirroring objects.test.ts's db-mock
// approach. Focused on the Phase C addition: `targetZone` still emits even
// when the room is unchanged (a within-room reposition), and rides the wire
// payload alongside from/to.

interface AgentRow {
  id: string;
  locationId: string;
}
interface EventRow {
  type: string;
  agentId: string | null;
  locationId: string | null;
  visibility: string;
  payload: Record<string, unknown>;
}

const rows: AgentRow[] = [{ id: "hobby", locationId: "park" }];
const events: EventRow[] = [];
let lastWhereId: string | undefined;

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => {
    lastWhereId = val as string;
    return { __eq: val };
  },
  sql: () => ({ __sql: true }),
}));

vi.mock("../db/client.js", () => {
  const agents = { id: {}, locationId: {} };
  const db = {
    select() {
      return { from: () => ({ where: () => rows.filter((r) => r.id === lastWhereId) }) };
    },
    update() {
      return {
        set(patch: { locationId?: string }) {
          return {
            where() {
              const row = rows.find((r) => r.id === lastWhereId);
              if (row && patch.locationId !== undefined) row.locationId = patch.locationId;
            },
          };
        },
      };
    },
    insert() {
      return {
        values(v: Omit<EventRow, "agentId"> & { agentId?: string | null }) {
          events.push({
            type: v.type,
            agentId: v.agentId ?? null,
            locationId: v.locationId ?? null,
            visibility: v.visibility,
            payload: v.payload,
          });
          return { returning: () => [{ id: events.length, ts: new Date() }] };
        },
      };
    },
  };
  return { db, schema: { agents } };
});

const { moveAgent } = await import("./agents.js");

beforeEach(() => {
  rows.length = 0;
  rows.push({ id: "hobby", locationId: "park" });
  events.length = 0;
  lastWhereId = undefined;
});

describe("moveAgent — targetZone (Phase C, space addressing)", () => {
  it("a plain room change emits agent.moved with targetZone: null", async () => {
    await moveAgent("hobby" as never, "town" as never);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ agent: "hobby", from: "park", to: "town", targetZone: null });
  });

  it("a room change WITH a targetZone carries it on the payload", async () => {
    await moveAgent("hobby" as never, "town" as never, "town.plaza-board");
    expect(events[0].payload).toMatchObject({ targetZone: "town.plaza-board" });
  });

  it("a within-room reposition (to === current location) still emits when targetZone is given", async () => {
    await moveAgent("hobby" as never, "park" as never, "park.bench-area");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ from: "park", to: "park", targetZone: "park.bench-area" });
  });

  it("a no-op move (same location, no targetZone) emits nothing", async () => {
    await moveAgent("hobby" as never, "park" as never);
    expect(events).toHaveLength(0);
  });

  it("still persists locationId even on a within-room reposition (no actual change)", async () => {
    await moveAgent("hobby" as never, "park" as never, "park.bench-area");
    expect(rows[0].locationId).toBe("park");
  });
});
