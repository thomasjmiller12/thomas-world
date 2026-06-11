import { describe, it, expect } from "vitest";
import type { WorldEvent } from "@town/contract";
import { scopeEventsForAgent } from "./events.js";
import { checkGate } from "./locations.js";

// Helper to build a minimal WorldEvent of a given type/visibility/location.
function ev(
  type: WorldEvent["type"],
  opts: Partial<{
    id: string;
    locationId: WorldEvent["locationId"];
    agentId: WorldEvent["agentId"];
    visibility: WorldEvent["visibility"];
    payload: Record<string, unknown>;
  }> = {},
): WorldEvent {
  return {
    id: opts.id ?? "1",
    ts: "2026-06-11T00:00:00.000Z",
    type,
    agentId: opts.agentId ?? null,
    locationId: opts.locationId ?? null,
    visibility: opts.visibility ?? "public",
    payload: (opts.payload ?? {}) as never,
  } as WorldEvent;
}

describe("perception scoping (plan §3.4)", () => {
  it("delivers full detail for events at the agent's own location", () => {
    const events = [
      ev("agent.spoke", {
        locationId: "workshop",
        agentId: "builder",
        visibility: "location",
        payload: { agent: "builder", location: "workshop", text: "shipping it" },
      }),
    ];
    const scoped = scopeEventsForAgent(events, "hobby", "workshop");
    expect(scoped).toHaveLength(1);
    expect((scoped[0].payload as { text: string }).text).toBe("shipping it");
  });

  it("drops location-scoped events that happened elsewhere", () => {
    const events = [
      ev("agent.spoke", {
        locationId: "workshop",
        visibility: "location",
        payload: { agent: "builder", location: "workshop", text: "secret" },
      }),
    ];
    const scoped = scopeEventsForAgent(events, "writer", "cafe");
    expect(scoped).toHaveLength(0);
  });

  it("delivers public events from elsewhere but only as a headline", () => {
    const events = [
      ev("agent.spoke", {
        locationId: "town",
        visibility: "public",
        payload: { agent: "career", location: "town", text: "loud announcement" },
      }),
    ];
    const scoped = scopeEventsForAgent(events, "writer", "cafe");
    expect(scoped).toHaveLength(1);
    // headline collapses the speech body
    expect((scoped[0].payload as { text: string }).text).toBe("");
  });

  it("keeps full public detail when the public event is at your location", () => {
    const events = [
      ev("bulletin.posted", {
        locationId: "town",
        visibility: "public",
        payload: { artifactId: "a1", agent: "career", title: "Notice" },
      }),
    ];
    const scoped = scopeEventsForAgent(events, "career", "town");
    expect(scoped).toHaveLength(1);
    expect((scoped[0].payload as { title: string }).title).toBe("Notice");
  });

  it("only the owning agent perceives its own private events", () => {
    const events = [
      ev("agent.thought", {
        agentId: "researcher",
        visibility: "private",
        payload: { agent: "researcher", text: "hmm" },
      }),
    ];
    expect(scopeEventsForAgent(events, "researcher", "library")).toHaveLength(1);
    expect(scopeEventsForAgent(events, "builder", "library")).toHaveLength(0);
  });

  it("never leaks a private DM headline to a non-recipient", () => {
    const events = [
      ev("message.sent", {
        agentId: "career",
        visibility: "private",
        payload: { from: "career", to: "writer", broadcast: false },
      }),
    ];
    // a third party in the same room must not see the DM
    expect(scopeEventsForAgent(events, "builder", "town")).toHaveLength(0);
  });
});

describe("location gates (plan §3.3)", () => {
  it("allows a gated capability from its required location", () => {
    expect(checkGate("post_bulletin", "town").allowed).toBe(true);
    expect(checkGate("email_thomas", "office").allowed).toBe(true);
    expect(checkGate("publish_blog_post", "cafe").allowed).toBe(true);
    expect(checkGate("request_capability", "office").allowed).toBe(true);
  });

  it("blocks a gated capability from the wrong location with in-fiction copy", () => {
    const r = checkGate("post_bulletin", "park");
    expect(r.allowed).toBe(false);
    expect(r.requiredLocation).toBe("town");
    expect(r.reason).toMatch(/town square/i);
  });

  it("never gates cognition or any ungated capability", () => {
    expect(checkGate("recall", "park").allowed).toBe(true);
    expect(checkGate("read_note", "workshop").allowed).toBe(true);
    expect(checkGate("send_dm", "library").allowed).toBe(true);
    expect(checkGate("say", "cafe").allowed).toBe(true);
  });
});
