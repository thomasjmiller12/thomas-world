import { describe, it, expect } from "vitest";
import {
  rowsToHistory,
  isChatStale,
  buildGreetingOpener,
  type ChatRowLike,
} from "./chat.js";
import type { WorldEvent } from "@town/contract";

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

describe("buildGreetingOpener — byte-stable continuity opener (design doc §3.4)", () => {
  const ev = (type: WorldEvent["type"], payload: Record<string, unknown>): WorldEvent =>
    ({
      id: "1",
      ts: "2026-06-11T00:00:00.000Z",
      type,
      agentId: "hobby",
      locationId: "workshop",
      visitorId: null,
      visibility: "public",
      payload,
    }) as WorldEvent;

  it("is byte-stable: same inputs → identical string (cache-friendly)", () => {
    const args = {
      displayName: "Hobby",
      activity: "tinkering with a marble run",
      recentEvents: [ev("artifact.created", { kind: "fun_list", title: "Rainy-day builds", agent: "hobby" })],
      visitorName: "Ada",
    };
    expect(buildGreetingOpener(args)).toBe(buildGreetingOpener(args));
  });

  it("leads with the visitor name and the current activity", () => {
    const opener = buildGreetingOpener({
      displayName: "Hobby",
      activity: "tinkering with a marble run",
      recentEvents: [],
      visitorName: "Ada",
    });
    expect(opener).toContain("Ada");
    expect(opener).toContain("tinkering with a marble run");
    expect(opener).toContain("Hobby");
  });

  it("falls back gracefully with no name and no activity", () => {
    const opener = buildGreetingOpener({
      displayName: "Hobby",
      activity: null,
      recentEvents: [],
      visitorName: null,
    });
    expect(opener).toContain("a visitor");
    expect(opener).toContain("between things");
  });

  it("includes at most the 3 most recent renderable events", () => {
    const events = [
      ev("agent.moved", { agent: "hobby", from: "town", to: "workshop" }),
      ev("agent.activity", { agent: "hobby", activity: "sketching" }),
      ev("artifact.created", { kind: "fun_list", title: "A", agent: "hobby" }),
      ev("artifact.updated", { title: "B", agent: "hobby" }),
    ];
    const opener = buildGreetingOpener({
      displayName: "Hobby",
      activity: "x",
      recentEvents: events,
      visitorName: "Ada",
    });
    // The oldest (moved) should be dropped; the newest 3 kept.
    expect(opener).not.toContain("walked to the workshop");
    expect(opener).toContain('updated "B"');
  });
});
