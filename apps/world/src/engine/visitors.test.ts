import { describe, it, expect, beforeEach, vi } from "vitest";

// engine/visitors.ts — Phase C.5 additions only (setVisitorZone, moveVisitor's
// zone-clearing on a room change). Mirrors agents.test.ts's db-mock approach.

interface VisitorRow {
  id: string;
  name: string;
  locationId: string | null;
  zone: string | null;
  lastSeenAt: Date;
}

const rows: VisitorRow[] = [
  { id: "v1", name: "Ada", locationId: "park", zone: null, lastSeenAt: new Date() },
];
const events: { type: string; payload: Record<string, unknown> }[] = [];
let lastWhereId: string | undefined;

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, val: unknown) => {
    lastWhereId = val as string;
    return { __eq: val };
  },
  and: (...conds: unknown[]) => ({ __and: conds }),
  gt: () => ({ __gt: true }),
  desc: (c: unknown) => c,
}));

vi.mock("../db/client.js", () => {
  const visitors = { id: {}, locationId: {}, zone: {}, lastSeenAt: {} };
  const db = {
    select() {
      return { from: () => ({ where: () => rows.filter((r) => r.id === lastWhereId) }) };
    },
    update() {
      return {
        set(patch: { locationId?: string | null; zone?: string | null }) {
          return {
            where() {
              const row = rows.find((r) => r.id === lastWhereId);
              if (!row) return;
              if (patch.locationId !== undefined) row.locationId = patch.locationId;
              if (patch.zone !== undefined) row.zone = patch.zone;
            },
          };
        },
      };
    },
  };
  return { db, schema: { visitors } };
});

vi.mock("./events.js", () => ({
  appendEvent: async (input: { type: string; payload: Record<string, unknown> }) => {
    events.push(input);
    return { id: String(events.length) };
  },
}));

const { moveVisitor, setVisitorZone, escortVisitorTo, isOwnerOrTestVisitor } = await import(
  "./visitors.js"
);

beforeEach(() => {
  rows.length = 0;
  rows.push({ id: "v1", name: "Ada", locationId: "park", zone: null, lastSeenAt: new Date() });
  events.length = 0;
  lastWhereId = undefined;
});

describe("isOwnerOrTestVisitor — owner-alert exclusion", () => {
  const OWNER_ID = "e92dff53-ecbf-49d0-8601-4d7658d1c2e3"; // default owner id

  it("treats the known owner visitor id as owner regardless of name", () => {
    expect(isOwnerOrTestVisitor(OWNER_ID, "Bill")).toBe(true);
    expect(isOwnerOrTestVisitor(OWNER_ID, "Haylee")).toBe(true);
  });

  it("treats any name containing 'thomas' as owner (case-insensitive)", () => {
    expect(isOwnerOrTestVisitor("other-id", "P-Thomas")).toBe(true);
    expect(isOwnerOrTestVisitor("other-id", "  P-THOMAS  ")).toBe(true);
  });

  it("treats dev smoke-test names as test", () => {
    expect(isOwnerOrTestVisitor("id-1", "Verifier")).toBe(true);
    expect(isOwnerOrTestVisitor("id-2", "SmokeTest")).toBe(true);
    expect(isOwnerOrTestVisitor("id-3", "debugsmoke")).toBe(true);
  });

  it("treats a genuine stranger (unknown id, ordinary name) as NOT owner/test", () => {
    expect(isOwnerOrTestVisitor("brand-new-id", "Ada")).toBe(false);
    expect(isOwnerOrTestVisitor("brand-new-id", "Bill")).toBe(false);
  });
});

describe("setVisitorZone", () => {
  it("sets the visitor's zone", async () => {
    await setVisitorZone("v1", "park.bench-area");
    expect(rows[0].zone).toBe("park.bench-area");
  });
});

describe("moveVisitor — clears zone on a room change", () => {
  it("a room change clears a previously-set zone", async () => {
    await setVisitorZone("v1", "park.bench-area");
    expect(rows[0].zone).toBe("park.bench-area");
    await moveVisitor("v1", "town" as never);
    expect(rows[0].zone).toBeNull();
    expect(rows[0].locationId).toBe("town");
  });

  it("a no-op move (same room) does not touch the stored zone", async () => {
    await setVisitorZone("v1", "park.bench-area");
    const res = await moveVisitor("v1", "park" as never);
    expect(res?.changed).toBe(false);
    expect(rows[0].zone).toBe("park.bench-area");
  });
});

describe("escortVisitorTo — invite_visitor's write path", () => {
  it("updates locationId + zone directly and dual-emits moved + escorted", async () => {
    const res = await escortVisitorTo("v1", "hobby" as never, "town" as never, "town.plaza-board");
    expect(res?.from).toBe("park");
    expect(rows[0].locationId).toBe("town");
    expect(rows[0].zone).toBe("town.plaza-board");

    const moved = events.find((e) => e.type === "visitor.moved");
    expect(moved?.payload).toMatchObject({ visitorId: "v1", from: "park", to: "town" });
    const escorted = events.find((e) => e.type === "visitor.escorted");
    expect(escorted?.payload).toMatchObject({
      visitorId: "v1",
      agent: "hobby",
      from: "park",
      to: "town",
      targetZone: "town.plaza-board",
    });
  });

  it("a same-room escort (a reposition) still emits visitor.escorted but not visitor.moved", async () => {
    await escortVisitorTo("v1", "hobby" as never, "park" as never, "park.bench-area");
    expect(events.some((e) => e.type === "visitor.moved")).toBe(false);
    expect(events.some((e) => e.type === "visitor.escorted")).toBe(true);
  });

  it("returns undefined for an unknown visitor (no events emitted)", async () => {
    const res = await escortVisitorTo("ghost", "hobby" as never, "town" as never);
    expect(res).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
