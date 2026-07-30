// Collision-aware object placement.
//
// Regression test for a real production collision (2026-07-30): agent-placed
// objects got their x from a pure hash of the object id with no awareness of the
// zone's existing occupants. Zones are small — `workshop.center` is 40px wide, a
// 28px usable band — so Builder's "Lights Out cabinet" landed at x=153 and the
// "Seed Garden planter" at x=159, six pixels apart on the same y. Two mounted
// interactive artifacts were drawn on top of each other, and an overlapped
// object can end up unclickable, meaning a real app a visitor cannot open.
//
// placementForZone is deliberately PURE (occupancy is passed in, not queried) so
// this behaviour is testable without a database.

import { describe, it, expect } from "vitest";
import { placementForZone, MIN_OBJECT_SEPARATION_PX } from "./objects.js";

// workshop.center is { x: 140, y: 80, w: 40, h: 40 } → band 146..174, y 118.
const LOC = "workshop";
const ZONE = "workshop.center";

describe("placementForZone", () => {
  it("places inside the zone's usable band, sitting at the front edge", () => {
    const p = placementForZone(LOC, ZONE, "workshop.thing-abcd");
    expect(p).not.toBeNull();
    expect(p!.scene).toBe("Workshop");
    expect(p!.x).toBeGreaterThanOrEqual(146);
    expect(p!.x).toBeLessThanOrEqual(174);
    expect(p!.y).toBe(118);
  });

  it("is deterministic for the same id", () => {
    const a = placementForZone(LOC, ZONE, "workshop.same-id");
    const b = placementForZone(LOC, ZONE, "workshop.same-id");
    expect(a).toEqual(b);
  });

  it("returns null for an unknown zone", () => {
    expect(placementForZone(LOC, "workshop.nowhere", "x")).toBeNull();
  });

  it("clears an occupant by at least the minimum separation", () => {
    // The exact collision from production: the planter already at x=159.
    const p = placementForZone(LOC, ZONE, "workshop.lights-out-cabinet-a50b", [
      { x: 159, y: 118 },
    ]);
    expect(p).not.toBeNull();
    expect(Math.abs(p!.x - 159)).toBeGreaterThanOrEqual(MIN_OBJECT_SEPARATION_PX);
  });

  it("keeps every object separated when a zone fills up one at a time", () => {
    // Simulate agents placing several objects, feeding back real occupancy each
    // time — the way createObject does.
    const occupied: { x: number; y: number }[] = [];
    const ids = ["a-1111", "b-2222", "c-3333"];
    for (const id of ids) {
      const p = placementForZone(LOC, ZONE, `workshop.${id}`, occupied);
      expect(p).not.toBeNull();
      for (const o of occupied) {
        expect(Math.abs(p!.x - o.x)).toBeGreaterThanOrEqual(MIN_OBJECT_SEPARATION_PX);
      }
      occupied.push({ x: p!.x, y: p!.y });
    }
    expect(new Set(occupied.map((o) => o.x)).size).toBe(ids.length);
  });

  it("still places something when the zone is genuinely full", () => {
    // Better a crowded zone than refusing to place — the agent asked for this.
    const full = [146, 160, 174].map((x) => ({ x, y: 118 }));
    const p = placementForZone(LOC, ZONE, "workshop.one-too-many", full);
    expect(p).not.toBeNull();
    expect(p!.x).toBeGreaterThanOrEqual(146);
    expect(p!.x).toBeLessThanOrEqual(174);
  });

  it("ignores occupants far enough away", () => {
    // An occupant outside the separation window must not push us off the slot the
    // hash chose, so placement stays stable as unrelated objects come and go.
    const alone = placementForZone(LOC, ZONE, "workshop.stable-id");
    const withFarNeighbour = placementForZone(LOC, ZONE, "workshop.stable-id", [
      { x: alone!.x + 400, y: 118 },
    ]);
    expect(withFarNeighbour).toEqual(alone);
  });
});
