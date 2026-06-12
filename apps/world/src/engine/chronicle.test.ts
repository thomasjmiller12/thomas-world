import { describe, it, expect } from "vitest";
import type { WorldEvent, AgentId } from "@town/contract";
import {
  groupSpokeIntoThreads,
  pairPresence,
  closedThreadsNeedingSummary,
  dayBounds,
  todayUtc,
  threadTranscript,
  THREAD_GAP_MS,
  type ChronicleThread,
} from "./chronicle.js";

// A minute in ms — gaps in these tests are expressed in minutes for clarity.
const MIN = 60_000;
const BASE = Date.UTC(2026, 5, 12, 9, 0, 0); // 2026-06-12T09:00:00Z

// Build an agent.spoke event at `minute` past BASE.
function spoke(
  id: string,
  minute: number,
  agent: AgentId,
  location: string,
  text: string,
  to?: AgentId,
): WorldEvent {
  return {
    id,
    ts: new Date(BASE + minute * MIN).toISOString(),
    type: "agent.spoke",
    agentId: agent,
    locationId: location as never,
    visitorId: null,
    visibility: "location",
    payload: { agent, location, text, ...(to ? { to } : {}) },
  } as WorldEvent;
}

// Build a historical conversation.turn event.
function convTurn(
  id: string,
  minute: number,
  conversationId: string,
  agent: AgentId,
  text: string,
  location?: string,
): WorldEvent {
  return {
    id,
    ts: new Date(BASE + minute * MIN).toISOString(),
    type: "conversation.turn",
    agentId: agent,
    locationId: (location ?? null) as never,
    visitorId: null,
    visibility: "location",
    payload: { conversationId, agent, text },
  } as WorldEvent;
}

describe("groupSpokeIntoThreads — emergent agent.spoke runs", () => {
  it("groups a consecutive same-location run into one thread", () => {
    const threads = groupSpokeIntoThreads([
      spoke("10", 0, "builder", "workshop", "morning"),
      spoke("11", 2, "researcher", "workshop", "morning back"),
      spoke("12", 5, "builder", "workshop", "what are you on today"),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].turns).toHaveLength(3);
    expect(threads[0].locationId).toBe("workshop");
  });

  it("splits into a new thread when the gap exceeds gapMs", () => {
    const threads = groupSpokeIntoThreads([
      spoke("10", 0, "builder", "workshop", "a"),
      spoke("11", 1, "builder", "workshop", "b"),
      // 13 min after the previous line (> 12 min default gap) → new thread.
      spoke("12", 14, "builder", "workshop", "c"),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].turns).toHaveLength(2);
    expect(threads[1].turns).toHaveLength(1);
  });

  it("splits when the location changes even within the gap", () => {
    const threads = groupSpokeIntoThreads([
      spoke("10", 0, "builder", "workshop", "a"),
      spoke("11", 1, "builder", "cafe", "b"), // moved rooms → new thread
      spoke("12", 2, "builder", "cafe", "c"),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].locationId).toBe("workshop");
    expect(threads[1].locationId).toBe("cafe");
    expect(threads[1].turns).toHaveLength(2);
  });

  it("allows a single-speaker run (a musing)", () => {
    const threads = groupSpokeIntoThreads([spoke("10", 0, "writer", "library", "hm.")]);
    expect(threads).toHaveLength(1);
    expect(threads[0].participants).toEqual(["writer"]);
    expect(threads[0].turns).toHaveLength(1);
  });

  it("orders participants by first line and dedupes", () => {
    const threads = groupSpokeIntoThreads([
      spoke("10", 0, "career", "cafe", "1"),
      spoke("11", 1, "hobby", "cafe", "2"),
      spoke("12", 2, "career", "cafe", "3"), // career already seen
      spoke("13", 3, "writer", "cafe", "4"),
    ]);
    expect(threads[0].participants).toEqual(["career", "hobby", "writer"]);
  });

  it("uses a deterministic thr-<location>-<firstEventId> id", () => {
    const threads = groupSpokeIntoThreads([
      spoke("42", 0, "builder", "workshop", "a"),
      spoke("43", 1, "builder", "workshop", "b"),
    ]);
    expect(threads[0].id).toBe("thr-workshop-42");
  });

  it("carries `to` addressing onto a turn and the thread ts is the first line", () => {
    const threads = groupSpokeIntoThreads([
      spoke("10", 0, "builder", "workshop", "hey", "researcher"),
      spoke("11", 1, "researcher", "workshop", "yo"),
    ]);
    expect(threads[0].turns[0].to).toBe("researcher");
    expect(threads[0].turns[1].to).toBeUndefined();
    expect(threads[0].ts).toBe(new Date(BASE).toISOString());
  });

  it("sorts the input chronologically before grouping (out-of-order ids)", () => {
    const threads = groupSpokeIntoThreads([
      spoke("12", 2, "builder", "workshop", "c"),
      spoke("10", 0, "builder", "workshop", "a"),
      spoke("11", 1, "builder", "workshop", "b"),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].turns.map((t) => t.text)).toEqual(["a", "b", "c"]);
    // First event by ts is id "10" → deterministic id uses it.
    expect(threads[0].id).toBe("thr-workshop-10");
  });
});

describe("groupSpokeIntoThreads — historical conversation.turn grouping", () => {
  it("groups conversation.turn by conversationId into a conv-<id> thread", () => {
    const threads = groupSpokeIntoThreads([
      convTurn("20", 0, "abc", "builder", "one", "library"),
      convTurn("21", 1, "abc", "researcher", "two"),
      convTurn("22", 2, "xyz", "writer", "other convo", "cafe"),
    ]);
    const ids = threads.map((t) => t.id).sort();
    expect(ids).toEqual(["conv-abc", "conv-xyz"]);
    const abc = threads.find((t) => t.id === "conv-abc")!;
    expect(abc.turns).toHaveLength(2);
    expect(abc.participants).toEqual(["builder", "researcher"]);
    expect(abc.locationId).toBe("library");
  });

  it("falls back to town when no turn carried a location", () => {
    const threads = groupSpokeIntoThreads([convTurn("20", 0, "abc", "builder", "one")]);
    expect(threads[0].locationId).toBe("town");
  });

  it("mixes emergent and historical threads, sorted by first ts", () => {
    const threads = groupSpokeIntoThreads([
      convTurn("20", 10, "abc", "builder", "later historical"),
      spoke("10", 0, "writer", "library", "earlier emergent"),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe("thr-library-10"); // ts=0 sorts first
    expect(threads[1].id).toBe("conv-abc"); // ts=10 sorts second
  });
});

describe("pairPresence", () => {
  const label = (id: AgentId) => ({ builder: "Builder", career: "Career" } as Record<string, string>)[id] ?? id;

  function chat(id: string, minute: number, type: "chat.started" | "chat.ended", agent: AgentId): WorldEvent {
    return {
      id,
      ts: new Date(BASE + minute * MIN).toISOString(),
      type,
      agentId: agent,
      locationId: null,
      visitorId: null,
      visibility: "public",
      payload: { agent, visitorId: "v1" },
    } as WorldEvent;
  }

  it("emits one presence beat per chat.started, naming the agent", () => {
    const items = pairPresence(
      [chat("30", 0, "chat.started", "builder"), chat("31", 5, "chat.ended", "builder")],
      label,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("presence");
    if (items[0].kind === "presence") {
      expect(items[0].agent).toBe("builder");
      expect(items[0].line).toBe("A visitor chatted with Builder.");
    }
  });

  it("emits a beat for a still-open chat (started, no end)", () => {
    const items = pairPresence([chat("30", 0, "chat.started", "career")], label);
    expect(items).toHaveLength(1);
  });

  it("does not emit a beat from a bare chat.ended", () => {
    const items = pairPresence([chat("31", 5, "chat.ended", "builder")], label);
    expect(items).toHaveLength(0);
  });
});

describe("closedThreadsNeedingSummary", () => {
  function thread(id: string, endMinute: number, summarized = false): ChronicleThread {
    return {
      kind: "thread",
      id,
      ts: new Date(BASE).toISOString(),
      locationId: "workshop",
      participants: ["builder"],
      summary: summarized ? "done" : null,
      turns: [{ agent: "builder", text: "x", ts: new Date(BASE + endMinute * MIN).toISOString() }],
      endTs: new Date(BASE + endMinute * MIN).toISOString(),
    };
  }

  const now = BASE + 30 * MIN; // 30 min after BASE

  it("returns a thread whose last line is older than the gap and has no summary", () => {
    const out = closedThreadsNeedingSummary([thread("a", 0)], new Set(), now);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });

  it("excludes an OPEN thread (last line within the gap)", () => {
    // endMinute 25 → last line 5 min before `now` (< 12 min gap) → still open.
    const out = closedThreadsNeedingSummary([thread("a", 25)], new Set(), now);
    expect(out).toHaveLength(0);
  });

  it("excludes threads already summarized (id in the set)", () => {
    const out = closedThreadsNeedingSummary([thread("a", 0)], new Set(["a"]), now);
    expect(out).toHaveLength(0);
  });

  it("treats endTs exactly gapMs old as closed (boundary)", () => {
    const t = thread("a", 0);
    const boundaryNow = BASE + THREAD_GAP_MS;
    const out = closedThreadsNeedingSummary([t], new Set(), boundaryNow);
    expect(out).toHaveLength(1);
  });
});

describe("dayBounds / todayUtc / threadTranscript", () => {
  it("computes a 24h UTC window for a valid day", () => {
    const { start, end } = dayBounds("2026-06-12");
    expect(start.toISOString()).toBe("2026-06-12T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-13T00:00:00.000Z");
  });

  it("throws on a malformed day", () => {
    expect(() => dayBounds("2026-6-12")).toThrow();
    expect(() => dayBounds("nope")).toThrow();
    expect(() => dayBounds("2026-13-40")).toThrow();
  });

  it("todayUtc returns a YYYY-MM-DD string", () => {
    expect(todayUtc(new Date("2026-06-12T23:59:00Z"))).toBe("2026-06-12");
  });

  it("threadTranscript renders labeled lines", () => {
    const t: ChronicleThread = {
      kind: "thread",
      id: "thr-cafe-1",
      ts: new Date(BASE).toISOString(),
      locationId: "cafe",
      participants: ["builder", "career"],
      summary: null,
      turns: [
        { agent: "builder", text: "hi", ts: new Date(BASE).toISOString() },
        { agent: "career", text: "hey", ts: new Date(BASE + MIN).toISOString() },
      ],
      endTs: new Date(BASE + MIN).toISOString(),
    };
    expect(threadTranscript(t)).toBe("Builder: hi\nCareer: hey");
  });
});
