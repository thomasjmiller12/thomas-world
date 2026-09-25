import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgent = vi.hoisted(() => vi.fn().mockResolvedValue({ locationId: "workshop" }));
vi.mock("../engine/agents.js", () => ({ getAgent }));

import { actionSummary, buildAgentActedEvent, relatedActionIds } from "./action-event.js";

describe("semantic agent actions", () => {
  beforeEach(() => getAgent.mockClear());

  it("summarizes actions without exposing private tool prose", () => {
    const args = {
      subject: "private subject",
      body: "extremely private body",
    };
    const summary = actionSummary("email_thomas", args);
    expect(summary).toBe("sent mail to P-Thomas");
    expect(summary).not.toContain(args.subject);
    expect(summary).not.toContain(args.body);
  });

  it("extracts typed public entity ids for later story grouping", () => {
    expect(
      relatedActionIds("write_artifact_state", {
        artifact_id: "art-1",
        visitorId: "visitor-2",
        key: "move",
        value: "private state value",
      }),
    ).toEqual([
      { kind: "artifact", id: "art-1" },
      { kind: "visitor", id: "visitor-2" },
    ]);
  });

  it("links movement and social actions to their semantic targets", () => {
    expect(relatedActionIds("move_to", { location: "library" })).toEqual([
      { kind: "location", id: "library" },
    ]);
    expect(relatedActionIds("send_dm", { agent: "writer", text: "private" })).toEqual([
      { kind: "agent", id: "writer" },
    ]);
  });

  it("builds a public agent.acted outbox event without serializing private data", async () => {
    const event = await buildAgentActedEvent({
      actionId: "action-1",
      agentId: "builder",
      tool: "send_dm",
      effect: "write",
      args: { agent: "writer", text: "private message" },
      result: "private provider result",
    });

    expect(event).toEqual({
      type: "agent.acted",
      agentId: "builder",
      locationId: "workshop",
      visibility: "public",
      payload: {
        agent: "builder",
        tool: "send_dm",
        effect: "write",
        summary: "sent a private note to another facet",
        actionId: "action-1",
        relatedIds: [{ kind: "agent", id: "writer" }],
      },
    });
    expect(JSON.stringify(event)).not.toContain("private message");
    expect(JSON.stringify(event)).not.toContain("private provider result");
  });
});
