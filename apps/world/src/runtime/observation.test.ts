import { describe, it, expect } from "vitest";
import { renderVisitorsSection } from "./observation.js";

// Location-aware Visitors section (design doc §2). Pure renderer: leads with
// who's HERE by name + arrival recency, then the town-wide count.
describe("renderVisitorsSection", () => {
  const now = 1_000_000_000_000;

  it("names a co-located visitor with 'here with you' and arrival recency", () => {
    const out = renderVisitorsSection(
      [{ id: "v1", name: "Ada" }],
      new Map([["v1", now - 2 * 60_000]]),
      1,
      now,
    );
    expect(out).toContain("Ada is here with you");
    expect(out).toContain("arrived 2 minutes ago");
  });

  it("says 'just walked in' for a very recent arrival", () => {
    const out = renderVisitorsSection([{ id: "v1", name: "Ada" }], new Map([["v1", now]]), 1, now);
    expect(out).toContain("just walked in");
  });

  it("notes other visitors elsewhere when town count exceeds those here", () => {
    const out = renderVisitorsSection([{ id: "v1", name: "Ada" }], new Map(), 3, now);
    expect(out).toContain("Ada is here with you");
    expect(out).toContain("2 more visitors elsewhere");
  });

  it("with no one here but visitors in town, points at the rest of town", () => {
    const out = renderVisitorsSection([], new Map(), 2, now);
    expect(out).toContain("No visitors here with you");
    expect(out).toContain("2 visitors are elsewhere");
  });

  it("with nobody in town at all, says the place is yours", () => {
    const out = renderVisitorsSection([], new Map(), 0, now);
    expect(out).toContain("The place is yours");
  });

  it("lists multiple co-located visitors", () => {
    const out = renderVisitorsSection(
      [
        { id: "v1", name: "Ada" },
        { id: "v2", name: "Bo" },
      ],
      new Map(),
      2,
      now,
    );
    expect(out).toContain("Ada is here with you");
    expect(out).toContain("Bo is here with you");
  });
});
