import { describe, expect, it } from "vitest";
import { interactiveAvailability } from "./snapshot.js";

describe("snapshot interactive availability", () => {
  it("keeps chat available whenever the daily budget remains", () => {
    expect(interactiveAvailability(false)).toBe(true);
  });

  it("enters dream mode when the daily budget is exhausted", () => {
    expect(interactiveAvailability(true)).toBe(false);
  });
});
