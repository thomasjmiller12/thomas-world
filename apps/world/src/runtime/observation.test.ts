import { describe, it, expect } from "vitest";
import type { WorldEvent } from "@town/contract";
import { renderVisitorsSection, renderEvents } from "./observation.js";

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

  it("with nobody in town at all, plainly reports no visitors (no nudge)", () => {
    const out = renderVisitorsSection([], new Map(), 0, now);
    expect(out).toBe("No visitors in town right now.");
  });

  it("carries NO instruction/nudge text (de-prescribed in M2.1)", () => {
    const out = renderVisitorsSection([{ id: "v1", name: "Ada" }], new Map(), 1, now);
    expect(out).not.toMatch(/say something/i);
    expect(out).not.toMatch(/standing there/i);
    expect(out).not.toMatch(/wander over/i);
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

// renderEvents addressing (M2.1 — emergent room talk via `say` with `to`). An
// addressed agent.spoke reads differently from the viewer's perspective.
describe("renderEvents — agent.spoke addressing", () => {
  const spoke = (payload: Record<string, unknown>): WorldEvent =>
    ({
      id: "1",
      ts: "2026-06-12T00:00:00.000Z",
      type: "agent.spoke",
      agentId: "builder",
      locationId: "workshop",
      visitorId: null,
      visibility: "location",
      payload,
    }) as WorldEvent;

  it("renders an unaddressed line as a plain 'said'", () => {
    const out = renderEvents([spoke({ agent: "builder", location: "workshop", text: "hey all" })], "workshop", "writer");
    expect(out).toBe(`- builder said: "hey all"`);
  });

  it("renders a line addressed TO the viewer as '(to you)'", () => {
    const out = renderEvents(
      [spoke({ agent: "builder", location: "workshop", text: "what do you think?", to: "writer" })],
      "workshop",
      "writer",
    );
    expect(out).toBe(`- builder said (to you): "what do you think?"`);
  });

  it("renders a line addressed to someone else as 'said to <name>'", () => {
    const out = renderEvents(
      [spoke({ agent: "builder", location: "workshop", text: "your call, researcher", to: "researcher" })],
      "workshop",
      "writer",
    );
    expect(out).toBe(`- builder said to researcher: "your call, researcher"`);
  });

  it("still renders the legacy conversation.* rows (historical world_events)", () => {
    const turn = {
      id: "2",
      ts: "2026-06-12T00:00:00.000Z",
      type: "conversation.turn",
      agentId: "builder",
      locationId: "workshop",
      visitorId: null,
      visibility: "location",
      payload: { conversationId: "c1", agent: "builder", text: "prototyping it" },
    } as WorldEvent;
    const out = renderEvents([turn], "workshop", "writer");
    expect(out).toBe(`- builder (in conversation): "prototyping it"`);
  });
});
