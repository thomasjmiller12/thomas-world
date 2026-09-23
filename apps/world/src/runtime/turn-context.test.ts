import { describe, expect, it } from "vitest";
import { townDate } from "./clock.js";
import { isQuietReply, permitsCodeExecution, turnContext } from "./turn-context.js";

describe("current-turn grounding", () => {
  it("keeps the town's date at UTC midnight and across daylight saving time", () => {
    expect(townDate(new Date("2026-09-23T01:00:00Z"))).toBe("2026-09-22");
    expect(townDate(new Date("2026-12-23T07:59:00Z"))).toBe("2026-12-22");
    expect(townDate(new Date("2026-12-23T08:01:00Z"))).toBe("2026-12-23");
  });

  it("ends reflection instructions on the next waking input without discarding history", () => {
    const input = turnContext("autonomous", new Date("2026-09-22T22:00:00Z"));
    expect(input).toContain("Town date: 2026-09-22");
    expect(input).toContain("previous reflection or visitor exchange has ended");
    expect(input).toContain("Do not continue writing a diary");
    expect(input).toContain("[quiet]");
    expect(turnContext("reflection")).toContain("for this turn only");
  });

  it("only grants hosted code execution for work, visitor, and delivery turns", () => {
    expect(permitsCodeExecution("interjection")).toBe(false);
    expect(permitsCodeExecution("reflection")).toBe(false);
    for (const purpose of ["autonomous", "visitor", "delivery"] as const) {
      expect(permitsCodeExecution(purpose)).toBe(true);
    }
  });

  it("only suppresses the exact autonomous silence marker", () => {
    expect(isQuietReply(" [quiet]\n")).toBe(true);
    expect(isQuietReply("It is [quiet] here")).toBe(false);
    expect(isQuietReply("Noted.")).toBe(false);
  });
});
