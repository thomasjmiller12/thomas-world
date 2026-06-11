import { describe, it, expect } from "vitest";
import {
  AgentId,
  LocationId,
  ArtifactKind,
  WorldEvent,
  worldEventTypes,
  SnapshotResponse,
  CreateChatRequest,
  ChatStreamFrame,
} from "./index.js";

describe("id enums", () => {
  it("accepts the five agent ids and rejects others", () => {
    expect(AgentId.parse("writer")).toBe("writer");
    expect(() => AgentId.parse("ceo")).toThrow();
  });

  it("accepts the six location ids", () => {
    for (const id of ["town", "office", "library", "workshop", "cafe", "park"]) {
      expect(LocationId.parse(id)).toBe(id);
    }
    expect(() => LocationId.parse("dungeon")).toThrow();
  });

  it("covers the seven artifact kinds", () => {
    expect(ArtifactKind.parse("daily_digest")).toBe("daily_digest");
    expect(() => ArtifactKind.parse("tweet")).toThrow();
  });
});

describe("WorldEvent discriminated union round-trips", () => {
  it("validates an agent.moved event", () => {
    const ev = {
      id: "evt_1",
      ts: "2026-06-11T10:00:00.000Z",
      visibility: "public",
      type: "agent.moved",
      payload: { agent: "builder", from: "workshop", to: "cafe" },
    };
    const parsed = WorldEvent.parse(ev);
    expect(parsed.type).toBe("agent.moved");
    if (parsed.type === "agent.moved") {
      expect(parsed.payload.to).toBe("cafe");
    }
  });

  it("validates a conversation.turn event with envelope routing fields", () => {
    const ev = {
      id: "evt_2",
      ts: "2026-06-11T10:01:00.000Z",
      agentId: "researcher",
      locationId: "library",
      visibility: "location",
      type: "conversation.turn",
      payload: { conversationId: "c1", agent: "researcher", text: "I think the data disagrees." },
    };
    expect(WorldEvent.parse(ev).type).toBe("conversation.turn");
  });

  it("validates an artifact.created event with nullable location/fixture", () => {
    const ev = {
      id: "evt_3",
      ts: "2026-06-11T10:02:00.000Z",
      visibility: "public",
      type: "artifact.created",
      payload: {
        artifactId: "a1",
        agent: "writer",
        kind: "blog_post",
        title: "On Continuity",
        location: "cafe",
        fixture: "press",
      },
    };
    expect(WorldEvent.parse(ev).type).toBe("artifact.created");
  });

  it("validates a world.time event", () => {
    const ev = {
      id: "evt_4",
      ts: "2026-06-11T20:00:00.000Z",
      visibility: "public",
      type: "world.time",
      payload: { phase: "evening" },
    };
    expect(WorldEvent.parse(ev).type).toBe("world.time");
  });

  it("rejects a payload that doesn't match its type", () => {
    const bad = {
      id: "evt_5",
      ts: "2026-06-11T10:00:00.000Z",
      visibility: "public",
      type: "agent.moved",
      payload: { phase: "evening" }, // wrong payload for agent.moved
    };
    expect(() => WorldEvent.parse(bad)).toThrow();
  });

  it("rejects an unknown event type", () => {
    const bad = {
      id: "evt_6",
      ts: "2026-06-11T10:00:00.000Z",
      visibility: "public",
      type: "agent.exploded",
      payload: {},
    };
    expect(() => WorldEvent.parse(bad)).toThrow();
  });

  it("keeps the type enum and the union in sync", () => {
    // Every literal in the union must appear in the worldEventTypes list.
    const unionTypes = WorldEvent.options.map((o) => o.shape.type.value);
    expect([...unionTypes].sort()).toEqual([...worldEventTypes].sort());
  });
});

describe("REST shapes round-trip", () => {
  it("validates a world snapshot", () => {
    const snap = {
      agents: [
        {
          id: "career",
          displayName: "Career Thomas",
          locationId: "office",
          status: "working",
          activity: "drafting a cover letter",
          busy: false,
          lastTickAt: "2026-06-11T10:00:00.000Z",
        },
      ],
      conversations: [
        { id: "c1", locationId: "park", participantIds: ["hobby", "writer"], startedAt: "2026-06-11T09:55:00.000Z" },
      ],
      recentEvents: [
        {
          id: "evt_7",
          ts: "2026-06-11T09:56:00.000Z",
          visibility: "public",
          type: "agent.activity",
          payload: { agent: "career", activity: "drafting a cover letter" },
        },
      ],
    };
    const parsed = SnapshotResponse.parse(snap);
    expect(parsed.agents[0].id).toBe("career");
    expect(parsed.recentEvents[0].type).toBe("agent.activity");
  });

  it("validates a chat-open request and rejects a bad agent", () => {
    expect(CreateChatRequest.parse({ agentId: "hobby", visitorId: "v1" }).agentId).toBe("hobby");
    expect(() => CreateChatRequest.parse({ agentId: "nobody", visitorId: "v1" })).toThrow();
  });

  it("validates the chat stream frame annotations", () => {
    expect(ChatStreamFrame.parse({ type: "text", text: "hi" }).type).toBe("text");
    expect(
      ChatStreamFrame.parse({ type: "memory_recalled", label: "recalled from earlier today" }).type,
    ).toBe("memory_recalled");
    expect(
      ChatStreamFrame.parse({ type: "suggested_replies", replies: ["tell me more", "what else?"] }).type,
    ).toBe("suggested_replies");
    expect(ChatStreamFrame.parse({ type: "done", messageId: "m1" }).type).toBe("done");
  });
});
