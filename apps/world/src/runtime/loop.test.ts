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

  it("matches a trailing vocative", () => {
    expect(addressedFacets(here, "what do you think, Writer?")).toEqual(["writer"]);
  });

  it("matches a bare-name opener on a question (how visitors actually type)", () => {
    expect(addressedFacets(here, "Builder what happened to the go board?")).toEqual(["builder"]);
  });
});

// ADDRESSING vs MENTIONING. Every match here pushes the named facet an immediate
// interrupt turn — a full LLM call. Before 2026-08-02 any whole-word hit counted,
// so talking ABOUT a facet summoned it: these are the real lines from that
// evening that woke Career and Writer for nothing and filled the park with
// "nothing new to add" chatter.
describe("addressedFacets (mentions must not summon)", () => {
  const here = [{ id: "writer" }, { id: "builder" }, { id: "career" }];

  it("ignores a third-person mention mid-sentence", () => {
    // Hobby, 2026-08-02 18:30 — describing them to a visitor, not calling them.
    // Career woke 4s later and Writer 22s later off this line.
    expect(
      addressedFacets(here, "I've got Career and Writer both feeding me sideline commentary"),
    ).toEqual([]);
  });

  it("ignores a name introduced by a dash mid-sentence", () => {
    // Hobby, 2026-08-02 18:32.
    expect(
      addressedFacets(
        here,
        "Round 5 is just the go table over there — Career opened it solo earlier, waiting on Builder to answer.",
      ),
    ).toEqual([]);
  });

  it("ignores a name as the subject of a sentence", () => {
    expect(addressedFacets(here, "Builder just told me he filed a request_capability")).toEqual([]);
    expect(addressedFacets(here, "Let's see if Builder answers the call this time")).toEqual([]);
  });

  it("ignores a possessive/plural form", () => {
    // A visitor's "somebody get builders ass in here" shouldn't summon either.
    expect(addressedFacets(here, "somebody get builders ass in here to fix this")).toEqual([]);
  });

  it("still summons when a mention and an address share a line", () => {
    // Evaluated per sentence, so one line can talk about Career and address Writer.
    expect(
      addressedFacets(here, "Career opened the board earlier. Writer, you seeing this?"),
    ).toEqual(["writer"]);
  });

  it("summons on a greeting form without punctuation", () => {
    expect(addressedFacets(here, "yo builder come look at this")).toEqual(["builder"]);
  });

  it("treats a sentence-opening discourse marker as narration, not a greeting", () => {
    // "so"/"no"/"yes" open a sentence the same way "hey" does but almost always
    // introduce a mention — keeping them out of VOCATIVE_LEAD is what makes this
    // matcher tighter than the old whole-word one rather than differently loose.
    expect(addressedFacets(here, "so Builder was saying the board is fine")).toEqual([]);
    expect(addressedFacets(here, "no Builder didn't get to it yet")).toEqual([]);
  });

  it("does not summon on a name that merely ends a sentence", () => {
    expect(addressedFacets(here, "Round 5's sitting pretty for Builder")).toEqual([]);
  });
});
