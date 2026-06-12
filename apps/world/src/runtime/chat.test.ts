import { describe, it, expect } from "vitest";
import {
  rowsToHistory,
  isChatStale,
  pickAddressedAgent,
  lastAgentToSpeak,
  isInterjectPass,
  interactionOperatorNote,
  pickRoutedSession,
  narrateAction,
  movementOperatorNote,
  type ChatRowLike,
  type RoutableSession,
} from "./chat.js";

const t = (s: number): Date => new Date(s * 1000);

describe("rowsToHistory — operator rows + assistant-never-first (design doc §3.4)", () => {
  it("renders agent rows as assistant and everything else as user", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "opener", ts: t(1) },
      { sender: "agent", body: "hi there", ts: t(2) },
      { sender: "visitor", body: "hello", ts: t(3) },
      { sender: "agent", body: "nice to meet you", ts: t(4) },
    ];
    expect(rowsToHistory(rows)).toEqual([
      { role: "user", content: "opener" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "nice to meet you" },
    ]);
  });

  it("the operator opener makes the leading turn a user turn (never assistant first)", () => {
    // The greeting persists an operator row FIRST, then the agent's assistant
    // reply — the API history must not start with an assistant message (400-trap).
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "a visitor walked up — greet them", ts: t(10) },
      { sender: "agent", body: "Oh, hey!", ts: t(11) },
    ];
    const history = rowsToHistory(rows);
    expect(history[0].role).toBe("user");
  });

  it("sorts by timestamp before mapping (insertion order independent)", () => {
    const rows: ChatRowLike[] = [
      { sender: "agent", body: "second", ts: t(20) },
      { sender: "operator", body: "first", ts: t(10) },
    ];
    const history = rowsToHistory(rows);
    expect(history[0]).toEqual({ role: "user", content: "first" });
    expect(history[1]).toEqual({ role: "assistant", content: "second" });
  });

  it("a transcript that begins with the visitor (no operator) still leads with user", () => {
    const rows: ChatRowLike[] = [
      { sender: "visitor", body: "knock knock", ts: t(1) },
      { sender: "agent", body: "who's there", ts: t(2) },
    ];
    expect(rowsToHistory(rows)[0].role).toBe("user");
  });
});

describe("isChatStale — liveness-aware sweep (design doc §3.4)", () => {
  const STALE = 3 * 60_000;
  const now = 1_000_000_000_000;

  it("a fresh ping keeps the session alive even with no messages", () => {
    expect(
      isChatStale(
        { startedAt: new Date(now - 10 * 60_000), lastPingAt: new Date(now - 30_000), lastMessageAt: null },
        now,
        STALE,
      ),
    ).toBe(false);
  });

  it("a recent message keeps the session alive even with no pings", () => {
    expect(
      isChatStale(
        { startedAt: new Date(now - 10 * 60_000), lastPingAt: null, lastMessageAt: new Date(now - 60_000) },
        now,
        STALE,
      ),
    ).toBe(false);
  });

  it("closes only when BOTH ping and message have gone quiet past staleMs", () => {
    expect(
      isChatStale(
        {
          startedAt: new Date(now - 30 * 60_000),
          lastPingAt: new Date(now - 4 * 60_000),
          lastMessageAt: new Date(now - 5 * 60_000),
        },
        now,
        STALE,
      ),
    ).toBe(true);
  });

  it("a brand-new session (just started, no ping/message) is not yet stale", () => {
    expect(
      isChatStale({ startedAt: new Date(now - 1_000), lastPingAt: null, lastMessageAt: null }, now, STALE),
    ).toBe(false);
  });
});

describe("rowsToHistory — group-chat perspective + labeling (design doc §3.3)", () => {
  it("renders the perspective agent's lines as assistant, the other agent's as labeled user", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "opener", ts: t(1) },
      { sender: "builder", body: "I'd ship it.", ts: t(2) },
      { sender: "visitor", body: "what about tests?", ts: t(3) },
      { sender: "researcher", body: "I'd measure first.", ts: t(4) },
    ];
    // From Builder's perspective: Builder → assistant, Researcher → labeled user.
    expect(rowsToHistory(rows, "builder")).toEqual([
      { role: "user", content: "opener" },
      { role: "assistant", content: "I'd ship it." },
      { role: "user", content: "what about tests?" },
      { role: "user", content: "Researcher: I'd measure first." },
    ]);
  });

  it("the same rows from the OTHER agent's perspective flip assistant/labeled-user", () => {
    const rows: ChatRowLike[] = [
      { sender: "builder", body: "ship it", ts: t(2) },
      { sender: "researcher", body: "measure first", ts: t(4) },
    ];
    expect(rowsToHistory(rows, "researcher")).toEqual([
      { role: "user", content: "Builder: ship it" },
      { role: "assistant", content: "measure first" },
    ]);
  });

  it("never starts with an assistant turn even with a perspective (400-trap)", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "a visitor jumped in — react", ts: t(1) },
      { sender: "builder", body: "oh, hi!", ts: t(2) },
    ];
    expect(rowsToHistory(rows, "builder")[0].role).toBe("user");
  });

  it("the legacy 'agent' sentinel maps to the perspective agent's assistant turn", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "opener", ts: t(1) },
      { sender: "agent", body: "hello", ts: t(2) },
    ];
    expect(rowsToHistory(rows, "hobby")).toEqual([
      { role: "user", content: "opener" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("without a perspective (1-agent chat) any agent line is the assistant", () => {
    const rows: ChatRowLike[] = [
      { sender: "visitor", body: "hi", ts: t(1) },
      { sender: "hobby", body: "hey there", ts: t(2) },
    ];
    expect(rowsToHistory(rows)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey there" },
    ]);
  });
});

describe("director addressing (design doc §3.3)", () => {
  it("routes to a participant named in the visitor text", () => {
    expect(
      pickAddressedAgent({
        participants: ["builder", "researcher"],
        visitorText: "Researcher, what do you think about the eval setup?",
        lastAgentSpoke: "builder",
        primary: "builder",
      }),
    ).toBe("researcher");
  });

  it("matches the agent label case-insensitively on a word boundary", () => {
    expect(
      pickAddressedAgent({
        participants: ["builder", "writer"],
        visitorText: "hey writer, got a sec?",
        lastAgentSpoke: null,
        primary: "builder",
      }),
    ).toBe("writer");
  });

  it("does NOT match a name embedded in a longer word", () => {
    // "writers" must not match "writer".
    expect(
      pickAddressedAgent({
        participants: ["builder", "writer"],
        visitorText: "do you both know any good writers conferences?",
        lastAgentSpoke: "builder",
        primary: "builder",
      }),
    ).toBe("builder"); // falls through to last-spoke
  });

  it("falls back to the last agent who spoke when no name is present", () => {
    expect(
      pickAddressedAgent({
        participants: ["builder", "researcher"],
        visitorText: "interesting — say more",
        lastAgentSpoke: "researcher",
        primary: "builder",
      }),
    ).toBe("researcher");
  });

  it("falls back to the primary when no name and no prior speaker", () => {
    expect(
      pickAddressedAgent({
        participants: ["builder", "researcher"],
        visitorText: "hello?",
        lastAgentSpoke: null,
        primary: "builder",
      }),
    ).toBe("builder");
  });

  it("ignores a last-speaker who is no longer a participant", () => {
    expect(
      pickAddressedAgent({
        participants: ["builder"],
        visitorText: "go on",
        lastAgentSpoke: "researcher",
        primary: "builder",
      }),
    ).toBe("builder");
  });
});

describe("lastAgentToSpeak (design doc §3.3 director step 2)", () => {
  it("returns the most recent explicit AgentId sender", () => {
    const rows: ChatRowLike[] = [
      { sender: "builder", body: "a", ts: t(1) },
      { sender: "visitor", body: "b", ts: t(2) },
      { sender: "researcher", body: "c", ts: t(3) },
    ];
    expect(lastAgentToSpeak(rows, "builder")).toBe("researcher");
  });

  it("resolves the legacy 'agent' sentinel to the primary", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "x", ts: t(1) },
      { sender: "agent", body: "y", ts: t(2) },
    ];
    expect(lastAgentToSpeak(rows, "hobby")).toBe("hobby");
  });

  it("returns null when no agent has spoken", () => {
    const rows: ChatRowLike[] = [
      { sender: "operator", body: "x", ts: t(1) },
      { sender: "visitor", body: "y", ts: t(2) },
    ];
    expect(lastAgentToSpeak(rows, "hobby")).toBeNull();
  });
});

describe("isInterjectPass (design doc §3.3 step 2)", () => {
  it("treats [pass] / pass / PASS as a pass", () => {
    expect(isInterjectPass("[pass]")).toBe(true);
    expect(isInterjectPass("pass")).toBe(true);
    expect(isInterjectPass("  PASS ")).toBe(true);
    expect(isInterjectPass("[pass].")).toBe(true);
  });

  it("treats a real line as NOT a pass", () => {
    expect(isInterjectPass("Actually, I'd push back on that.")).toBe(false);
    expect(isInterjectPass("passing the test was the goal")).toBe(false);
  });
});

describe("interactionOperatorNote (design doc §4 — visitor.interacted routing)", () => {
  it("special-cases the phone with the warranty-bit payoff line", () => {
    const note = interactionOperatorNote("Ada", "phone");
    expect(note).toMatch(/Ada/);
    expect(note).toMatch(/answered the phone/i);
    expect(note).toMatch(/\[operator note\]/);
  });

  it("falls back to a generic interacted line for other fixtures", () => {
    const note = interactionOperatorNote("Ada", "espresso machine");
    expect(note).toMatch(/interacted with the espresso machine/i);
  });

  it("uses 'The visitor' when no name is given", () => {
    expect(interactionOperatorNote("", "phone")).toMatch(/The visitor just answered the phone/i);
  });
});

describe("pickRoutedSession (design doc §4 — routing decision)", () => {
  const session = (id: string, ...locs: (string | null | undefined)[]): RoutableSession => ({
    id,
    participantLocations: locs as RoutableSession["participantLocations"],
  });

  it("routes to a session with a participant AT the interaction location", () => {
    expect(pickRoutedSession([session("s1", "office")], "office")).toBe("s1");
  });

  it("matches when ANY participant (group chat) is at the location", () => {
    // A 2-agent group chat: one agent elsewhere, one at the location → still routes.
    expect(pickRoutedSession([session("s1", "library", "office")], "office")).toBe("s1");
  });

  it("returns null when no participant is at the interaction location", () => {
    expect(pickRoutedSession([session("s1", "library")], "office")).toBeNull();
  });

  it("returns null with no live sessions", () => {
    expect(pickRoutedSession([], "office")).toBeNull();
  });

  it("picks the FIRST matching session when several qualify", () => {
    const sessions = [session("s1", "cafe"), session("s2", "office"), session("s3", "office")];
    expect(pickRoutedSession(sessions, "office")).toBe("s2");
  });

  it("ignores null/undefined participant locations (agent row gone)", () => {
    expect(pickRoutedSession([session("s1", null, undefined)], "office")).toBeNull();
  });
});

// Visitor speaks first (M2.1 — forced greeting removed). runChatTurn inserts the
// visitor row BEFORE building history, so a fresh session's first persisted row
// is the visitor's message → the leading history turn is a `user` turn. (No
// operator opener is written anymore; the only chat-stream entry is a visitor
// message.) rowsToHistory is the pure invariant under that flow.
describe("visitor speaks first (M2.1 — no forced greeting)", () => {
  it("a fresh session's first history entry is a user turn", () => {
    // The first row a brand-new session ever has is the visitor's opening line.
    const rows: ChatRowLike[] = [{ sender: "visitor", body: "hey, who are you?", ts: t(1) }];
    const history = rowsToHistory(rows, "hobby");
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("hey, who are you?");
  });
});

// Mid-chat action-frame narration (M2.1 full agency). Pure map from a tool +
// its parsed args to the inline `detail` the panel renders.
describe("narrateAction — mid-chat tool narration map (M2.1)", () => {
  it("narrates move_to with the destination", () => {
    expect(narrateAction("move_to", { location: "cafe" })).toBe("walks to the cafe");
  });

  it("narrates use_fixture as '<action>s the <fixture>'", () => {
    expect(narrateAction("use_fixture", { fixture: "phone", action: "ring" })).toBe("rings the phone");
  });

  it("narrates create_artifact with the title in quotes", () => {
    expect(narrateAction("create_artifact", { title: "Eval design", kind: "blog_post" })).toBe(
      'starts writing "Eval design"',
    );
  });

  it("narrates update_artifact generically", () => {
    expect(narrateAction("update_artifact", { id: "42" })).toBe("revises an artifact");
  });

  it("narrates set_activity with the text", () => {
    expect(narrateAction("set_activity", { text: "sketching a marble run" })).toBe(
      "is now sketching a marble run",
    );
  });

  it("narrates say with the spoken text in quotes", () => {
    expect(narrateAction("say", { text: "anyone around?" })).toBe('says aloud: "anyone around?"');
  });

  it("returns null for tools with their own frames / no narration", () => {
    expect(narrateAction("memory", { command: "view" })).toBeNull();
    expect(narrateAction("recall", { query: "x" })).toBeNull();
    expect(narrateAction("leave_chat", { reason: "bye" })).toBeNull();
    expect(narrateAction("invite_to_chat", { agent: "builder" })).toBeNull();
  });

  it("falls back gracefully when an expected field is missing", () => {
    expect(narrateAction("move_to", {})).toBe("walks to the somewhere");
    expect(narrateAction("create_artifact", {})).toBe('starts writing "something"');
  });
});

// Visitor-movement routing note (M2.1). Pure decision: phrasing depends only on
// whether a participant agent is at the destination the visitor walked to.
describe("movementOperatorNote — visitor.moved routing (M2.1)", () => {
  it("reads 'walked into the <loc> with you' when a participant is at the destination", () => {
    const note = movementOperatorNote("Ada", "cafe", true);
    expect(note).toBe("[operator note] Ada just walked into the cafe with you.");
  });

  it("reads 'walked over to the <loc>' when no participant is at the destination", () => {
    const note = movementOperatorNote("Ada", "park", false);
    expect(note).toBe("[operator note] Ada just walked over to the park.");
  });

  it("uses 'The visitor' when no name is given", () => {
    expect(movementOperatorNote("", "office", false)).toMatch(/^\[operator note\] The visitor just walked over to the office\.$/);
  });
});
