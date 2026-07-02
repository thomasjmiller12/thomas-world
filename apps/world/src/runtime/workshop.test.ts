import { describe, it, expect } from "vitest";
import { searchObjectTemplates } from "./tools.js";
import { OBJECT_TEMPLATES } from "../engine/object-templates.js";
import { placementForZone } from "../engine/objects.js";

// Programmable-world pure logic: the library search agents use to find props,
// and the zone→placement-point picker place_object uses.

describe("searchObjectTemplates", () => {
  it("finds by name fragment and by tag", () => {
    const arcade = searchObjectTemplates("arcade");
    expect(arcade.length).toBeGreaterThan(0);
    expect(arcade.every((n) => n in OBJECT_TEMPLATES)).toBe(true);

    const seats = searchObjectTemplates("chair");
    expect(seats.length).toBeGreaterThan(0);
  });

  it("empty / no-match queries return []", () => {
    expect(searchObjectTemplates("")).toEqual([]);
    expect(searchObjectTemplates("xyzzyplugh")).toEqual([]);
  });

  it("caps results", () => {
    expect(searchObjectTemplates("table", 5).length).toBeLessThanOrEqual(5);
  });
});

describe("placementForZone", () => {
  it("lands inside the zone's bounds, near the bottom", () => {
    const p = placementForZone("park", "park.bench-area", "park.arcade-abcd");
    // park.bench-area bounds: Town scene, x88 y356 w40 h40 (engine/zones.ts).
    expect(p).not.toBeNull();
    expect(p!.scene).toBe("Town");
    expect(p!.x).toBeGreaterThanOrEqual(88);
    expect(p!.x).toBeLessThanOrEqual(88 + 40);
    expect(p!.y).toBeGreaterThanOrEqual(356 + 20);
    expect(p!.y).toBeLessThanOrEqual(356 + 40);
  });

  it("is deterministic per id but scatters different ids", () => {
    const a1 = placementForZone("cafe", "cafe.tables", "cafe.zine-rack-aaaa");
    const a2 = placementForZone("cafe", "cafe.tables", "cafe.zine-rack-aaaa");
    const b = placementForZone("cafe", "cafe.tables", "cafe.jukebox-bbbb");
    expect(a1).toEqual(a2);
    expect(a1!.x === b!.x).toBe(false);
  });

  it("unknown zone → null (renderer falls back to the room anchor)", () => {
    expect(placementForZone("park", "park.no-such-zone", "x")).toBeNull();
  });
});
