import { describe, it, expect, beforeEach, vi } from "vitest";

// setObjectState test (Director/Effect object-surface write path). We mock the
// drizzle client with a tiny in-memory store modelling the two tables this path
// touches — worldObjects (load + state merge + persist) and worldEvents (the
// object.state_changed append) — and the SSE bus, so the merge + emit logic runs
// without a live Postgres (mirrors memory.test.ts's db-mock approach).

interface ObjRow {
  id: string;
  locationId: string;
  state: Record<string, unknown> | null;
  updatedAt: Date;
  displayName: string;
}
interface EventRow {
  type: string;
  agentId: string | null;
  locationId: string | null;
  visitorId: string | null;
  visibility: string;
  payload: Record<string, unknown>;
}

const objects: ObjRow[] = [];
const events: EventRow[] = [];
const published: unknown[] = [];

// Capture the id used in the last where(eq(id, ...)) so update/select can target.
let lastWhereId: string | undefined;

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => {
    lastWhereId = val as string;
    return { __eq: val };
  },
  and: (...a: unknown[]) => ({ __and: a }),
  asc: (c: unknown) => c,
  desc: (c: unknown) => c,
  inArray: () => ({ __in: true }),
  sql: () => ({ __sql: true }),
}));

vi.mock("./bus.js", () => ({ publish: (e: unknown) => published.push(e) }));

vi.mock("../db/client.js", () => {
  const worldObjects = { id: {}, state: {}, updatedAt: {} };
  const worldEvents = { id: {} };
  const db = {
    select() {
      return {
        from(tbl: unknown) {
          return {
            where() {
              if (tbl === worldObjects) {
                return objects.filter((o) => o.id === lastWhereId);
              }
              return [];
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: { state?: Record<string, unknown>; updatedAt?: Date }) {
          return {
            where() {
              const row = objects.find((o) => o.id === lastWhereId);
              if (row) {
                if (patch.state !== undefined) row.state = patch.state;
                if (patch.updatedAt !== undefined) row.updatedAt = patch.updatedAt;
              }
            },
          };
        },
      };
    },
    insert() {
      return {
        values(v: Omit<EventRow, "agentId"> & { agentId?: string | null }) {
          const row: EventRow = {
            type: v.type,
            agentId: v.agentId ?? null,
            locationId: v.locationId ?? null,
            visitorId: v.visitorId ?? null,
            visibility: v.visibility,
            payload: v.payload,
          };
          events.push(row);
          return {
            returning() {
              return [{ id: 1, ts: new Date(), ...row }];
            },
          };
        },
      };
    },
  };
  return { db, schema: { worldObjects, worldEvents } };
});

const { setObjectState } = await import("./objects.js");

beforeEach(() => {
  objects.length = 0;
  events.length = 0;
  published.length = 0;
  lastWhereId = undefined;
});

describe("setObjectState — merge + emit", () => {
  it("missing object returns { ok:false } and emits nothing", async () => {
    const res = await setObjectState("park.payphone", "hobby", "ring", { ringing: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("object-missing");
    expect(events).toHaveLength(0);
  });

  it("shallow-merges the patch into existing state and emits object.state_changed", async () => {
    objects.push({
      id: "park.payphone",
      locationId: "park",
      state: { color: "red" },
      updatedAt: new Date(0),
      displayName: "payphone",
    });

    const res = await setObjectState("park.payphone", "hobby", "ring", { ringing: true });
    expect(res.ok).toBe(true);

    // Persisted state is the shallow merge (kept color, added ringing).
    const row = objects.find((o) => o.id === "park.payphone")!;
    expect(row.state).toEqual({ color: "red", ringing: true });
    expect(row.updatedAt.getTime()).toBeGreaterThan(0);

    // The canonical perception event carries the merged state + effect.
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("object.state_changed");
    expect(e.visibility).toBe("location");
    expect(e.locationId).toBe("park");
    expect(e.agentId).toBe("hobby");
    expect(e.payload).toMatchObject({
      objectId: "park.payphone",
      agent: "hobby",
      location: "park",
      effect: "ring",
      state: { color: "red", ringing: true },
    });
  });

  it("a null statePatch still emits and bumps updatedAt without losing state", async () => {
    objects.push({
      id: "office.lamp",
      locationId: "office",
      state: { on: true },
      updatedAt: new Date(0),
      displayName: "lamp",
    });
    const res = await setObjectState("office.lamp", null, "flicker");
    expect(res.ok).toBe(true);
    expect(objects.find((o) => o.id === "office.lamp")!.state).toEqual({ on: true });
    expect(events[0].agentId).toBeNull();
    expect(events[0].payload.effect).toBe("flicker");
  });
});
