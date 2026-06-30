import { describe, it, expect, beforeEach, vi } from "vitest";

// Director/Effect protocol dispatcher tests. The DB-touching engine deps
// (objects/events) and the chat-session lookup are mocked so the dispatcher's
// LOGIC — beat validation, surface routing, dual-emit, target resolution,
// pending-call lifecycle — is exercised without a live Postgres. The rate
// limiter (fixtures.ts) is the REAL pure helper (reset per spec) so the
// rate-limit refusal path runs end to end.

// --- mocks ------------------------------------------------------------------
const appendEventMock = vi.fn(async (_input: unknown) => ({ id: "1" }));
const setObjectStateMock = vi.fn(async () => ({ ok: true as boolean, reason: undefined as string | undefined }));
const objectsAtLocationMock = vi.fn(async () => [] as { id: string; displayName: string; kind: string | null }[]);
const findObjectAtLocationMock = vi.fn(
  async () => undefined as { id: string; displayName: string; kind: string | null } | undefined,
);
const eventsOfTypesMock = vi.fn(async () => [] as unknown[]);
const getSessionMock = vi.fn(async () => null as { agentId: string; visitorId: string } | null);

vi.mock("../engine/events.js", () => ({
  appendEvent: (input: unknown) => appendEventMock(input),
  eventsOfTypes: (...args: unknown[]) => eventsOfTypesMock(...(args as [])),
}));
vi.mock("../engine/objects.js", () => ({
  setObjectState: (...args: unknown[]) => setObjectStateMock(...(args as [])),
  objectsAtLocation: (...args: unknown[]) => objectsAtLocationMock(...(args as [])),
  findObjectAtLocation: (...args: unknown[]) => findObjectAtLocationMock(...(args as [])),
}));
vi.mock("./chat.js", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...(args as [])),
}));

import { playBeat, consumePendingCall, _resetPendingCalls, _resetVisitorPacing } from "./director.js";
import { _resetEffectLimiter } from "./fixtures.js";
import type { AgentContext } from "./tools.js";

const PHONE = { id: "park.payphone", displayName: "payphone", kind: "device" as const };

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return { agentId: "hobby", location: "park", ...over };
}

beforeEach(() => {
  _resetEffectLimiter();
  _resetPendingCalls();
  _resetVisitorPacing();
  appendEventMock.mockClear();
  setObjectStateMock.mockClear();
  setObjectStateMock.mockResolvedValue({ ok: true, reason: undefined });
  objectsAtLocationMock.mockClear();
  objectsAtLocationMock.mockResolvedValue([]);
  findObjectAtLocationMock.mockClear();
  findObjectAtLocationMock.mockResolvedValue(undefined);
  eventsOfTypesMock.mockClear();
  eventsOfTypesMock.mockResolvedValue([]);
  getSessionMock.mockClear();
  getSessionMock.mockResolvedValue(null);
});

describe("playBeat — validation", () => {
  it("an unknown beat returns an in-fiction error listing the real beats", async () => {
    const out = await playBeat(ctx(), { beat: "nope", params: {} });
    expect(out).toMatch(/no bit called "nope"/i);
    expect(out).toMatch(/phone-ring/);
    // No effect was recorded / emitted on a validation miss.
    expect(appendEventMock).not.toHaveBeenCalled();
    expect(setObjectStateMock).not.toHaveBeenCalled();
  });

  it("bad params (popup-card missing title) returns an in-fiction error, no emit", async () => {
    const out = await playBeat(ctx(), { beat: "popup-card", params: { body: "hi" } });
    expect(out).toMatch(/won't go/i);
    expect(appendEventMock).not.toHaveBeenCalled();
  });
});

describe("playBeat — rate limiting (shares use_fixture's 20/hr knob)", () => {
  it("refuses once the per-hour cap is hit, with an in-fiction line", async () => {
    objectsAtLocationMock.mockResolvedValue([PHONE]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);
    const CAP = 20; // fixtures.ts MAX_PER_WINDOW
    for (let i = 0; i < CAP; i++) {
      const ok = await playBeat(ctx(), { beat: "phone-ring", params: {} });
      expect(ok).toMatch(/run the bit/i);
    }
    const refused = await playBeat(ctx(), { beat: "phone-ring", params: {} });
    expect(refused).toMatch(/let it breathe|lands once/i);
  });
});

describe("playBeat — object surface (phone-ring)", () => {
  it("resolves the object, sets state, and DUAL-EMITS world.effect", async () => {
    objectsAtLocationMock.mockResolvedValue([PHONE]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);

    const out = await playBeat(ctx(), { beat: "phone-ring", object: "payphone", params: {} });
    expect(out).toMatch(/run the bit/i);

    // setObjectState got the effect + statePatch from the beat def.
    expect(setObjectStateMock).toHaveBeenCalledWith(
      "park.payphone",
      "hobby",
      "ring",
      { ringing: true },
    );
    // world.effect dual-emit with the object's displayName as the fixture.
    const effectCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.effect",
    );
    expect(effectCall).toBeTruthy();
    expect((effectCall![0] as { payload: { fixture: string; effect: string } }).payload).toMatchObject(
      { fixture: "payphone", effect: "ring" },
    );
  });

  it("a ring records a pending call consumable once", async () => {
    objectsAtLocationMock.mockResolvedValue([PHONE]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);
    await playBeat(ctx(), { beat: "phone-ring", params: {} });

    const first = consumePendingCall("park.payphone");
    expect(first).toEqual({ agentId: "hobby" });
    // One-shot: a second consume sees nothing.
    expect(consumePendingCall("park.payphone")).toBeNull();
  });

  it("falls back to the location's device phone when object is omitted", async () => {
    objectsAtLocationMock.mockResolvedValue([
      { id: "park.bench", displayName: "bench", kind: "decoration" },
      PHONE,
    ]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);
    await playBeat(ctx(), { beat: "phone-ring", params: {} });
    // The default resolver chose the phone by name; findObjectAtLocation got it.
    expect(findObjectAtLocationMock).toHaveBeenCalledWith("park", "payphone");
  });

  it("returns an in-fiction miss (no emit) when no object is here", async () => {
    objectsAtLocationMock.mockResolvedValue([]);
    const out = await playBeat(ctx(), { beat: "phone-ring", params: {} });
    expect(out).toMatch(/nothing here/i);
    expect(setObjectStateMock).not.toHaveBeenCalled();
  });
});

// The use_fixture → beats consolidation: lamp-flicker/espresso-hiss/board-rustle
// migrate the old free-string fixture verbs into the catalog. Default-object
// resolution now matches on `affordances` (seeded straight from each fixture's
// action whitelist) rather than a per-effect name regex, so it generalizes to a
// non-"device" fixture like the notice board for free.
describe("playBeat — consolidated fixture beats (lamp/espresso/board)", () => {
  it("board-rustle resolves the notice board by affordance, not kind", async () => {
    const BOARD = {
      id: "town.notice-board",
      displayName: "notice board",
      kind: "bulletin_board" as const,
      affordances: ["rustle"],
    };
    objectsAtLocationMock.mockResolvedValue([BOARD]);
    findObjectAtLocationMock.mockResolvedValue(BOARD);
    const out = await playBeat(ctx({ location: "town" }), { beat: "board-rustle", params: {} });
    expect(out).toMatch(/run the bit/i);
    expect(findObjectAtLocationMock).toHaveBeenCalledWith("town", "notice board");
    expect(setObjectStateMock).toHaveBeenCalledWith("town.notice-board", "hobby", "rustle", undefined);
  });

  it("lamp-flicker and espresso-hiss dual-emit world.effect with their effect keyword", async () => {
    const LAMP = { id: "library.lamp", displayName: "lamp", kind: "device", affordances: ["flicker"] };
    objectsAtLocationMock.mockResolvedValue([LAMP]);
    findObjectAtLocationMock.mockResolvedValue(LAMP);
    await playBeat(ctx({ location: "library" }), { beat: "lamp-flicker", params: {} });
    const effectCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.effect",
    )![0] as { payload: { effect: string } };
    expect(effectCall.payload.effect).toBe("flicker");
  });
});

describe("playBeat — per-visitor pacing budget (Phase B)", () => {
  // resolveTargetVisitor only consults getSession when the turn is a chat reply
  // (ctx.chatSessionId set) — these beats target whoever's in the chat session.
  const chatCtx = ctx({ chatSessionId: "sess-pace" });

  it("refuses a 5th directed screen beat at one visitor within the window", async () => {
    getSessionMock.mockResolvedValue({ agentId: "hobby", visitorId: "visitor-7" });
    for (let i = 0; i < 4; i++) {
      const out = await playBeat(chatCtx, { beat: "confetti", params: {} });
      expect(out).toMatch(/visitor's screen/i);
    }
    const refused = await playBeat(chatCtx, { beat: "confetti", params: {} });
    expect(refused).toMatch(/had a few bits land/i);
  });

  it("does not pace a room-audience beat (emote) even after the visitor cap", async () => {
    getSessionMock.mockResolvedValue({ agentId: "hobby", visitorId: "visitor-7" });
    for (let i = 0; i < 4; i++) await playBeat(chatCtx, { beat: "confetti", params: {} });
    // The visitor-7 directed budget is now exhausted, but emote is audience:"room"
    // (visitorId always null) so it never consults the per-visitor pacing map.
    const out = await playBeat(chatCtx, { beat: "emote", params: { emoji: "🤝" } });
    expect(out).toMatch(/everyone here/i);
  });

  it("paces independently per visitor", async () => {
    getSessionMock.mockResolvedValue({ agentId: "hobby", visitorId: "visitor-A" });
    for (let i = 0; i < 4; i++) await playBeat(chatCtx, { beat: "confetti", params: {} });
    getSessionMock.mockResolvedValue({ agentId: "hobby", visitorId: "visitor-B" });
    const out = await playBeat(chatCtx, { beat: "confetti", params: {} });
    expect(out).toMatch(/visitor's screen/i); // a different visitor, fresh budget
  });
});

describe("playBeat — screen surface targeting", () => {
  it("popup-card targets the chat-session visitor", async () => {
    getSessionMock.mockResolvedValue({ agentId: "hobby", visitorId: "visitor-7" });
    const out = await playBeat(ctx({ chatSessionId: "sess-1" }), {
      beat: "popup-card",
      params: { title: "Vehicle Services", body: "your car's extended warranty", tone: "gag" },
    });
    expect(out).toMatch(/visitor's screen/i);
    const beatCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.beat",
    )![0] as { visitorId: string; payload: { visitorId: string; beat: string } };
    expect(beatCall.visitorId).toBe("visitor-7");
    expect(beatCall.payload).toMatchObject({ visitorId: "visitor-7", beat: "popup-card" });
  });

  it("popup-card falls back to a recent local interactor when no chat session", async () => {
    eventsOfTypesMock.mockResolvedValue([
      {
        id: "9",
        ts: new Date().toISOString(),
        type: "visitor.interacted",
        locationId: "park",
        payload: { visitorId: "visitor-walkby" },
      },
    ]);
    const out = await playBeat(ctx(), {
      beat: "popup-card",
      params: { title: "hey", body: "you answered" },
    });
    expect(out).toMatch(/visitor's screen/i);
    const beatCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.beat",
    )![0] as { visitorId: string };
    expect(beatCall.visitorId).toBe("visitor-walkby");
  });

  it("emote (audience:room) goes room-wide (visitorId null) without resolving a target", async () => {
    const out = await playBeat(ctx(), { beat: "emote", params: { emoji: "🤝" } });
    expect(out).toMatch(/everyone here/i);
    // room-audience beats never look up a target visitor.
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(eventsOfTypesMock).not.toHaveBeenCalled();
    const beatCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.beat",
    )![0] as { visitorId: string | null };
    expect(beatCall.visitorId).toBeNull();
  });

  it("popup-card with no resolvable target plays room-wide (visitorId null)", async () => {
    const out = await playBeat(ctx(), {
      beat: "popup-card",
      params: { title: "hi", body: "anybody" },
    });
    expect(out).toMatch(/plays to the room/i);
    const beatCall = appendEventMock.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "world.beat",
    )![0] as { visitorId: string | null };
    expect(beatCall.visitorId).toBeNull();
  });
});

describe("consumePendingCall — TTL (10min, widened from the original 2min for reliability) + one-shot", () => {
  it("returns null for an object with no pending call", () => {
    expect(consumePendingCall("nope.nothing")).toBeNull();
  });

  it("a pickup 5 minutes later still hits (would have missed the old 2min TTL)", async () => {
    objectsAtLocationMock.mockResolvedValue([PHONE]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);
    const t0 = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    await playBeat(ctx(), { beat: "phone-ring", params: {} });
    vi.restoreAllMocks();
    expect(consumePendingCall("park.payphone", t0 + 5 * 60_000)).toEqual({ agentId: "hobby" });
  });

  it("a call older than the 10min TTL is treated as absent (and pruned)", async () => {
    objectsAtLocationMock.mockResolvedValue([PHONE]);
    findObjectAtLocationMock.mockResolvedValue(PHONE);
    const t0 = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    await playBeat(ctx(), { beat: "phone-ring", params: {} });
    vi.restoreAllMocks();
    // Consume 11 minutes later → stale → null, and the entry is gone afterward.
    expect(consumePendingCall("park.payphone", t0 + 11 * 60_000)).toBeNull();
    expect(consumePendingCall("park.payphone")).toBeNull();
  });
});
