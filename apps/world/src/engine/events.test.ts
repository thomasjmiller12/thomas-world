import { describe, it, expect } from "vitest";
import type { WorldEvent } from "@town/contract";
import { publicView } from "./events.js";

// Minimal WorldEvent builder for the pure publicView filter.
function ev(id: string, visibility: WorldEvent["visibility"]): WorldEvent {
  return {
    id,
    ts: "2026-06-11T00:00:00.000Z",
    type: "agent.thought",
    agentId: "career",
    locationId: "office",
    visitorId: null,
    visibility,
    payload: { agent: "career", text: "x" },
  } as WorldEvent;
}

describe("publicView (design doc §5 — the three HTTP read sites)", () => {
  it("drops private events and keeps public + location", () => {
    const out = publicView([
      ev("1", "public"),
      ev("2", "private"),
      ev("3", "location"),
      ev("4", "private"),
    ]);
    expect(out.map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("preserves input order of the surviving events (pagination-safe)", () => {
    const out = publicView([ev("10", "location"), ev("11", "public"), ev("12", "location")]);
    expect(out.map((e) => e.id)).toEqual(["10", "11", "12"]);
  });

  it("returns an empty array when everything is private", () => {
    expect(publicView([ev("1", "private"), ev("2", "private")])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [ev("1", "public"), ev("2", "private")];
    publicView(input);
    expect(input).toHaveLength(2);
  });
});
