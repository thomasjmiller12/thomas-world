import { describe, it, expect } from "vitest";
import {
  AgentId,
  LocationId,
  ArtifactKind,
  WorldEvent,
  worldEventTypes,
  SnapshotResponse,
  CreateChatRequest,
  CreateChatResponse,
  CreateVisitorResponse,
  GetVisitorResponse,
  PatchVisitorRequest,
  InteractRequest,
  GetChatResponse,
  HealthResponse,
  FeedResponse,
  AgentStatus,
  ChatStreamFrame,
  ChronicleResponse,
  ExternalReference,
  PortfolioProof,
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
      recentEvents: [
        {
          id: "evt_7",
          ts: "2026-06-11T09:56:00.000Z",
          visibility: "public",
          type: "agent.activity",
          payload: { agent: "career", activity: "drafting a cover letter" },
        },
      ],
      world: { phase: "morning", visitorsPresent: 2, awake: true },
    };
    const parsed = SnapshotResponse.parse(snap);
    expect(parsed.agents[0].id).toBe("career");
    expect(parsed.recentEvents[0].type).toBe("agent.activity");
    expect(parsed.world.phase).toBe("morning");
    expect(parsed.world.awake).toBe(true);
  });

  it("validates a chat-open request and rejects a bad agent", () => {
    expect(CreateChatRequest.parse({ agentId: "hobby", visitorId: "v1" }).agentId).toBe("hobby");
    expect(() => CreateChatRequest.parse({ agentId: "nobody", visitorId: "v1" })).toThrow();
  });

  it("validates the chat stream frame annotations", () => {
    expect(ChatStreamFrame.parse({ type: "turn_started", agent: "writer" }).type).toBe("turn_started");
    expect(ChatStreamFrame.parse({ type: "text", text: "hi", agent: "writer" }).type).toBe("text");
    expect(
      ChatStreamFrame.parse({
        type: "memory_recalled",
        label: "recalled from earlier today",
        agent: "writer",
      }).type,
    ).toBe("memory_recalled");
    expect(
      ChatStreamFrame.parse({ type: "suggested_replies", replies: ["tell me more", "what else?"] }).type,
    ).toBe("suggested_replies");
    // done carries messageId; agent is optional
    expect(ChatStreamFrame.parse({ type: "done", messageId: "m1" }).type).toBe("done");
    expect(ChatStreamFrame.parse({ type: "done", messageId: "m1", agent: "hobby" }).type).toBe("done");
    // text frames now require an agent for attribution
    expect(() => ChatStreamFrame.parse({ type: "text", text: "hi" })).toThrow();
    // M2.1: inline action narration mid-chat
    expect(
      ChatStreamFrame.parse({
        type: "action",
        agent: "builder",
        tool: "walk",
        detail: "walks to the cafe",
      }).type,
    ).toBe("action");
    // M2.1: the agent can end the chat itself; reason optional
    expect(ChatStreamFrame.parse({ type: "chat_ended", agent: "writer" }).type).toBe("chat_ended");
    expect(
      ChatStreamFrame.parse({ type: "chat_ended", agent: "writer", reason: "heading off to write" }).type,
    ).toBe("chat_ended");
  });

  it("validates a ChronicleResponse with each item kind", () => {
    const res = ChronicleResponse.parse({
      day: "2026-06-12",
      days: ["2026-06-12", "2026-06-11"],
      issue: null,
      items: [
        {
          kind: "thread",
          id: "t1",
          ts: "2026-06-12T10:00:00.000Z",
          locationId: "cafe",
          participants: ["writer", "hobby"],
          summary: "Riffing on a side project.",
          turns: [
            { agent: "writer", to: "hobby", text: "what are you building?", ts: "2026-06-12T10:00:00.000Z" },
            { agent: "hobby", text: "a tiny synth", ts: "2026-06-12T10:00:05.000Z" },
          ],
        },
        {
          kind: "artifact",
          id: "a1",
          ts: "2026-06-12T11:00:00.000Z",
          action: "created",
          artifact: {
            id: "art1",
            agentId: "writer",
            kind: "blog_post",
            title: "On Continuity",
            locationId: "cafe",
            fixture: "press",
            createdAt: "2026-06-12T11:00:00.000Z",
            updatedAt: "2026-06-12T11:00:00.000Z",
            published: true,
          },
        },
        {
          kind: "bulletin",
          id: "b1",
          ts: "2026-06-12T12:00:00.000Z",
          agent: "career",
          title: "Open office hours",
          artifactId: "art2",
        },
        {
          kind: "effect",
          id: "e1",
          ts: "2026-06-12T13:00:00.000Z",
          locationId: "office",
          line: "The office phone rang.",
        },
        {
          kind: "presence",
          id: "p1",
          ts: "2026-06-12T14:00:00.000Z",
          agent: "researcher",
          line: "Researcher settled into the library.",
        },
      ],
    });
    expect(res.day).toBe("2026-06-12");
    expect(res.days).toEqual(["2026-06-12", "2026-06-11"]);
    expect(res.items[0].kind).toBe("thread");
    if (res.items[0].kind === "thread") {
      expect(res.items[0].turns[0].to).toBe("hobby");
      expect(res.items[0].turns[1].to).toBeUndefined();
    }
    // unknown item kind is rejected
    expect(() =>
      ChronicleResponse.parse({ day: "2026-06-12", days: [], issue: null, items: [{ kind: "rumor", id: "r1", ts: "x" }] }),
    ).toThrow();
  });
});

describe("M2.2 schemas (Town Crier, portfolio, share cards)", () => {
  it("accepts a ChronicleResponse carrying a generated issue", () => {
    const res = ChronicleResponse.parse({
      day: "2026-06-20",
      days: ["2026-06-20"],
      issue: {
        day: "2026-06-20",
        status: "ready",
        title: "A Quiet Morning at the Workshop",
        subtitle: "Builder ships, Writer watches",
        byline: "The Town Crier",
        bodyMd: "Builder spent the morning on the machinery [S1].",
        sections: [
          { id: "around", title: "Around Town", bodyMd: "Writer left a note [S2].", citationIds: ["S2"] },
        ],
        citations: [
          { id: "S1", kind: "artifact", targetId: "art1", label: "Project log", href: "artifact:art1" },
          { id: "S2", kind: "thread", targetId: "thr1", label: "Cafe chatter" },
        ],
        generatedAt: "2026-06-20T08:05:00.000Z",
        latestMeaningfulDay: null,
      },
      items: [],
    });
    expect(res.issue?.status).toBe("ready");
    expect(res.issue?.citations[0].kind).toBe("artifact");
  });

  it("rejects an invalid citation kind", () => {
    expect(() =>
      ChronicleResponse.parse({
        day: "2026-06-20",
        days: [],
        issue: {
          day: "2026-06-20",
          status: "ready",
          title: "t",
          subtitle: null,
          byline: "The Town Crier",
          bodyMd: "b",
          sections: [],
          citations: [{ id: "S1", kind: "not_a_kind", targetId: "x", label: "y" }],
          generatedAt: null,
        },
        items: [],
      }),
    ).toThrow();
  });

  it("round-trips a share_card chat frame", () => {
    const frame = ChatStreamFrame.parse({
      type: "share_card",
      agent: "builder",
      card: {
        id: "ref:billables-ai",
        kind: "external_reference",
        title: "Billables AI",
        subtitle: null,
        summary: "Legal-AI startup Thomas founded.",
        agentId: "builder",
        sourceLabel: "Project",
        actions: [{ label: "Open", href: "https://example.com", kind: "external" }],
      },
    });
    expect(frame.type).toBe("share_card");
  });

  it("validates an ExternalReference and PortfolioProof", () => {
    const ref = ExternalReference.parse({
      id: "thomass-town",
      kind: "project",
      title: "Thomas's Town",
      shortTitle: null,
      summary: "A living-portfolio agent town.",
      bodyMd: null,
      url: "https://town.example.com",
      githubUrl: null,
      liveUrl: null,
      imageUrl: null,
      agentIds: ["builder", "writer"],
      tags: ["agents", "portfolio"],
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    expect(ref.kind).toBe("project");
    const proof = PortfolioProof.parse({
      id: "persistent-agents",
      title: "Persistent Agent Architecture",
      claim: "Agents live outside the browser.",
      summary: "A world server runs five agents 24/7.",
      bodyMd: "## Evidence",
      agentIds: ["builder"],
      skills: ["systems", "agents"],
      artifactIds: [],
      eventIds: [],
      referenceIds: ["thomass-town"],
      featured: true,
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    expect(proof.featured).toBe(true);
  });
});

describe("M2 event payloads round-trip", () => {
  it("validates a visitor.moved event with nullable `from`", () => {
    const ev = {
      id: "evt_m1",
      ts: "2026-06-11T10:00:00.000Z",
      visibility: "public",
      type: "visitor.moved",
      payload: { visitorId: "v1", name: "Ada", from: null, to: "library" },
    };
    const parsed = WorldEvent.parse(ev);
    expect(parsed.type).toBe("visitor.moved");
    if (parsed.type === "visitor.moved") {
      expect(parsed.payload.from).toBeNull();
      expect(parsed.payload.to).toBe("library");
    }
  });

  it("validates a visitor.interacted event", () => {
    const ev = {
      id: "evt_m2",
      ts: "2026-06-11T10:01:00.000Z",
      visibility: "public",
      type: "visitor.interacted",
      payload: { visitorId: "v1", name: "Ada", location: "office", fixture: "phone" },
    };
    expect(WorldEvent.parse(ev).type).toBe("visitor.interacted");
  });

  it("validates a world.effect event with and without an agent", () => {
    const withAgent = {
      id: "evt_m3",
      ts: "2026-06-11T10:02:00.000Z",
      visibility: "public",
      type: "world.effect",
      payload: { location: "office", fixture: "phone", effect: "ring", agent: "hobby" },
    };
    expect(WorldEvent.parse(withAgent).type).toBe("world.effect");
    const ambient = {
      id: "evt_m4",
      ts: "2026-06-11T10:02:30.000Z",
      visibility: "public",
      type: "world.effect",
      payload: { location: "town", fixture: "notice board", effect: "rustle" },
    };
    expect(WorldEvent.parse(ambient).type).toBe("world.effect");
  });

  it("validates chat.joined (sessionId optional) and conversation.converted", () => {
    const joinedPublic = {
      id: "evt_m5",
      ts: "2026-06-11T10:03:00.000Z",
      visibility: "public",
      type: "chat.joined",
      payload: { agent: "researcher" }, // presence only, no sessionId
    };
    expect(WorldEvent.parse(joinedPublic).type).toBe("chat.joined");
    const joinedFeed = {
      id: "evt_m6",
      ts: "2026-06-11T10:03:30.000Z",
      visibility: "private",
      type: "chat.joined",
      payload: { agent: "researcher", sessionId: "s1" },
    };
    expect(WorldEvent.parse(joinedFeed).type).toBe("chat.joined");
    const converted = {
      id: "evt_m7",
      ts: "2026-06-11T10:04:00.000Z",
      visibility: "public",
      type: "conversation.converted",
      payload: { conversationId: "c1" },
    };
    expect(WorldEvent.parse(converted).type).toBe("conversation.converted");
  });
});

describe("M2 REST shapes round-trip", () => {
  it("validates a HealthResponse", () => {
    const h = HealthResponse.parse({
      ok: true,
      ts: "2026-06-11T10:00:00.000Z",
      llm: true,
      budgetExhausted: false,
    });
    expect(h.budgetExhausted).toBe(false);
  });

  it("validates an AgentStatus", () => {
    const a = AgentStatus.parse({
      id: "builder",
      displayName: "Builder Thomas",
      locationId: "workshop",
      status: "in conversation",
      activity: null,
      lastTickAt: null,
    });
    expect(a.id).toBe("builder");
    // The removed engagement-era fields (busy/engagement) are stripped, not
    // rejected — a not-yet-redeployed world server that still sends them must
    // parse cleanly on a newer frontend.
    const legacy = AgentStatus.parse({
      id: "writer",
      displayName: "Writer Thomas",
      locationId: "cafe",
      status: "working",
      activity: "drafting",
      busy: false,
      engagement: { kind: "chat", with: ["visitor"] },
      lastTickAt: null,
    });
    expect("busy" in legacy).toBe(false);
    expect("engagement" in legacy).toBe(false);
  });

  it("validates a FeedResponse with typed/located items and a count", () => {
    const feed = FeedResponse.parse({
      items: [
        {
          id: "f1",
          ts: "2026-06-11T10:00:00.000Z",
          agent: "writer",
          line: "Writer published a post.",
          type: "artifact.created",
          locationId: "cafe",
          to: null,
        },
        {
          id: "f2",
          ts: "2026-06-11T10:01:00.000Z",
          agent: null,
          line: "The office phone rang. Nobody knows why.",
          type: null,
          locationId: null,
          to: null,
        },
      ],
      nextCursor: null,
      count: 2,
    });
    expect(feed.count).toBe(2);
    expect(feed.items[0].type).toBe("artifact.created");
    expect(feed.items[1].type).toBeNull();
  });

  it("validates visitor identity shapes (create/get/patch/interact)", () => {
    const created = CreateVisitorResponse.parse({
      visitorId: "v1",
      name: "Ada",
      visitorToken: "tok_abc",
    });
    expect(created.visitorToken).toBe("tok_abc");
    // token must not be optional
    expect(() => CreateVisitorResponse.parse({ visitorId: "v1", name: "Ada" })).toThrow();

    const got = GetVisitorResponse.parse({ visitorId: "v1", name: "Ada", locationId: "library" });
    expect(got.locationId).toBe("library");
    expect(GetVisitorResponse.parse({ visitorId: "v1", name: "Ada", locationId: null }).locationId).toBeNull();

    expect(PatchVisitorRequest.parse({ locationId: "park" }).locationId).toBe("park");
    expect(PatchVisitorRequest.parse({ name: "Ada B." }).name).toBe("Ada B.");
    expect(() => PatchVisitorRequest.parse({ locationId: "dungeon" })).toThrow();

    expect(InteractRequest.parse({ locationId: "office", fixture: "phone" }).fixture).toBe("phone");
    expect(() => InteractRequest.parse({ locationId: "office", fixture: "" })).toThrow();
  });

  it("validates a full CreateChatResponse with participants + token", () => {
    const res = CreateChatResponse.parse({
      sessionId: "s1",
      agentId: "hobby",
      visitorId: "v1",
      participants: ["hobby"],
      sessionToken: "stok_1",
    });
    expect(res.participants).toEqual(["hobby"]);
    expect(res.sessionToken).toBe("stok_1");
  });

  it("validates a GetChatResponse transcript (visitor + agent senders only)", () => {
    const chat = GetChatResponse.parse({
      sessionId: "s1",
      visitorId: "v1",
      participants: ["hobby"],
      messages: [
        { id: "m1", sender: "visitor", body: "hi", ts: "2026-06-11T10:00:00.000Z" },
        { id: "m2", sender: "hobby", body: "hey there", ts: "2026-06-11T10:00:05.000Z" },
      ],
    });
    expect(chat.messages[0].sender).toBe("visitor");
    expect(chat.messages[1].sender).toBe("hobby");
    // operator rows are never exposed — `operator` is not a valid sender here
    expect(() =>
      GetChatResponse.parse({
        sessionId: "s1",
        visitorId: "v1",
        participants: ["hobby"],
        messages: [{ id: "m3", sender: "operator", body: "note", ts: "2026-06-11T10:00:00.000Z" }],
      }),
    ).toThrow();
  });
});

describe("programmable-world schemas (D1–D4)", () => {
  it("parses the new artifact kinds", () => {
    expect(ArtifactKind.parse("interactive")).toBe("interactive");
    expect(ArtifactKind.parse("shared_page")).toBe("shared_page");
  });

  it("round-trips artifact.state_changed (keys only, never values)", () => {
    const ev = WorldEvent.parse({
      id: "evt_ps1",
      ts: "2026-07-02T10:00:00.000Z",
      visibility: "public",
      type: "artifact.state_changed",
      payload: { artifactId: "a1", keys: ["board"], agent: null, visitorId: "v1" },
    });
    expect(ev.type).toBe("artifact.state_changed");
    if (ev.type === "artifact.state_changed") {
      expect(ev.payload.keys).toEqual(["board"]);
      expect(ev.payload.visitorId).toBe("v1");
    }
  });

  it("round-trips object.created with a placement hint and object.removed", () => {
    const created = WorldEvent.parse({
      id: "evt_ps2",
      ts: "2026-07-02T10:01:00.000Z",
      visibility: "public",
      type: "object.created",
      payload: {
        objectId: "cafe.arcade-1a2b",
        agent: "hobby",
        location: "cafe",
        zone: "cafe.tables",
        template: "arcade-controller-handheld",
        displayName: "arcade corner",
        placement: { scene: "Cafe", x: 140, y: 120 },
      },
    });
    expect(created.type).toBe("object.created");
    if (created.type === "object.created") {
      expect(created.payload.placement?.scene).toBe("Cafe");
    }
    const removed = WorldEvent.parse({
      id: "evt_ps3",
      ts: "2026-07-02T10:02:00.000Z",
      visibility: "public",
      type: "object.removed",
      payload: { objectId: "cafe.arcade-1a2b", agent: "hobby", location: "cafe", displayName: "arcade corner" },
    });
    expect(removed.type).toBe("object.removed");
  });
});
