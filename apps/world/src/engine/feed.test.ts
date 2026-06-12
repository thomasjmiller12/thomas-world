import { describe, it, expect } from "vitest";
import type { WorldEvent } from "@town/contract";
import { enrichFeedRow } from "./feed.js";

function evt(partial: Partial<WorldEvent>): WorldEvent {
  return {
    id: "1",
    ts: "2026-06-11T00:00:00.000Z",
    type: "agent.activity",
    agentId: "career",
    locationId: "office",
    visitorId: null,
    visibility: "public",
    payload: {},
    ...partial,
  } as WorldEvent;
}

describe("feed enrichment (design doc §5 — type/locationId/to)", () => {
  it("carries the source type and location onto the row", () => {
    const row = enrichFeedRow(
      evt({ type: "agent.activity", locationId: "library", payload: { agent: "researcher", activity: "x" } }),
      "Researcher is x.",
    );
    expect(row.type).toBe("agent.activity");
    expect(row.locationId).toBe("library");
    expect(row.line).toBe("Researcher is x.");
  });

  it("sets `to` from the payload only for directed message.sent DMs", () => {
    const dm = enrichFeedRow(
      evt({ type: "message.sent", locationId: null, payload: { from: "career", to: "builder", broadcast: false } }),
      "Career sent a DM to Builder.",
    );
    expect(dm.to).toBe("builder");
  });

  it("leaves `to` null for a broadcast message.sent (no recipient)", () => {
    const bc = enrichFeedRow(
      evt({ type: "message.sent", locationId: null, payload: { from: "career", to: null, broadcast: true } }),
      "Career broadcast a message to everyone.",
    );
    expect(bc.to).toBeNull();
  });

  it("leaves `to` null for non-message events even if a `to` key exists", () => {
    const other = enrichFeedRow(
      evt({ type: "agent.moved", payload: { agent: "career", from: "office", to: "town" } }),
      "Career walked from office to town.",
    );
    // `to` is a LocationId in the payload here, NOT a recipient agent — must not leak.
    expect(other.to).toBeNull();
  });

  it("maps a null event location to a null row location", () => {
    const row = enrichFeedRow(evt({ type: "world.time", locationId: null, agentId: null, payload: { phase: "morning" } }), "It's now morning.");
    expect(row.locationId).toBeNull();
    expect(row.agent).toBeNull();
  });
});
