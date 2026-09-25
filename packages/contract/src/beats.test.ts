import { describe, expect, it } from "vitest";
import { BEATS } from "./beats.js";

describe("fixture effects", () => {
  it("permits answering without opening the effect vocabulary to arbitrary text", () => {
    expect(BEATS["fixture-effect"].params.parse({ effect: "answer" })).toEqual({ effect: "answer" });
    expect(BEATS["fixture-effect"].params.safeParse({ effect: "invent-call" }).success).toBe(false);
  });
});
