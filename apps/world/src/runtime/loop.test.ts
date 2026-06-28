import { describe, it, expect } from "vitest";
import { addressedFacets } from "./loop.js";

// The addressing matcher decides which co-located facets a line "summons" — used
// for facet→facet speech AND for a visitor naming a facet to pull them into the
// chat (M-room). `here` always excludes the speaker.
describe("addressedFacets (room addressing)", () => {
  const here = [{ id: "writer" }, { id: "builder" }, { id: "researcher" }];

  it("matches a facet named in the line, case-insensitively", () => {
    expect(addressedFacets(here, "Writer, what do you think?")).toEqual(["writer"]);
    expect(addressedFacets(here, "hey writer come over")).toEqual(["writer"]);
  });

  it("matches multiple named facets", () => {
    expect(addressedFacets(here, "Writer and Builder, join us")).toEqual([
      "writer",
      "builder",
    ]);
  });

  it("ignores facets not present (not in `here`)", () => {
    // Career isn't co-located, so naming them addresses no one here.
    expect(addressedFacets(here, "Career should weigh in")).toEqual([]);
  });

  it("only whole-word matches (no substring false positives)", () => {
    // "rewriter" contains "writer" but must not match.
    expect(addressedFacets(here, "I am rewriting this draft")).toEqual([]);
  });

  it("returns nothing when no facet is named", () => {
    expect(addressedFacets(here, "just thinking out loud")).toEqual([]);
  });
});
