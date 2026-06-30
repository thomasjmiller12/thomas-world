import { describe, it, expect, beforeEach } from "vitest";
import { enqueue, registerExecutor, _resetQueueForTest, type AgentInput } from "./queue.js";

// The per-agent input queue (M3): one worker per agent, interrupt inputs jump
// ahead of queued normal inputs but never abort a running turn, and duplicate
// normal ticks coalesce. We register a controllable fake executor to drive it.

const visitorInput = (text: string): AgentInput => ({
  kind: "visitor",
  sessionId: "s1",
  visitorId: "v1",
  visitorName: "Ada",
  text,
  handlers: { onFrame: () => {} },
});

describe("agent input queue", () => {
  beforeEach(() => _resetQueueForTest());

  it("runs an interrupt ahead of a queued normal tick, without aborting the running one", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    registerExecutor(async (_id, input) => {
      calls++;
      if (calls === 1) await firstGate; // hold the first turn so the rest queue behind it
      order.push(
        input.kind === "visitor"
          ? "visitor"
          : input.kind === "tick" && input.interrupt
            ? "interrupt-tick"
            : "tick",
      );
      return { ran: true };
    });

    const p1 = enqueue("career", { kind: "tick" }); // starts running, blocks on the gate
    const p2 = enqueue("career", { kind: "tick" }); // queued (normal)
    const p3 = enqueue("career", visitorInput("hi")); // interrupt → inserted ahead of p2
    releaseFirst();
    await Promise.all([p1, p2, p3]);

    // The first tick was already running (can't be jumped); the visitor interrupt
    // then runs ahead of the still-queued normal tick.
    expect(order).toEqual(["tick", "visitor", "tick"]);
  });

  it("coalesces a duplicate queued normal tick", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    registerExecutor(async () => {
      calls++;
      if (calls === 1) await firstGate;
      return { ran: true };
    });

    const p1 = enqueue("writer", { kind: "tick" }); // running, blocked
    const p2 = enqueue("writer", { kind: "tick" }); // queued
    const p3 = enqueue("writer", { kind: "tick" }); // duplicate of the queued one → coalesced

    const r3 = await p3;
    expect(r3.reason).toBe("coalesced");

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(calls).toBe(2); // only p1 + p2 ran; p3 was coalesced
  });

  it("keeps a normal tick and an interrupt tick as distinct (no cross-coalesce)", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    registerExecutor(async () => {
      calls++;
      if (calls === 1) await firstGate;
      return { ran: true };
    });

    const p1 = enqueue("hobby", { kind: "tick" }); // running, blocked
    const p2 = enqueue("hobby", { kind: "tick" }); // queued normal
    const p3 = enqueue("hobby", { kind: "tick", interrupt: true }); // queued interrupt (distinct)

    releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(3);
  });

  it("never coalesces a tick carrying a directive note (a pending-call wake)", async () => {
    // A bare interrupt tick is already queued; a SECOND interrupt tick carrying a
    // note (e.g. the pending-call pickup cue) must still run — it's rare and
    // load-bearing, unlike a redundant bare tick.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    const seen: Array<string | undefined> = [];
    registerExecutor(async (_id, input) => {
      calls++;
      if (calls === 1) await firstGate;
      seen.push(input.kind === "tick" ? input.note : undefined);
      return { ran: true };
    });

    const p1 = enqueue("builder", { kind: "tick", interrupt: true }); // running, blocked
    const p2 = enqueue("builder", { kind: "tick", interrupt: true }); // queued interrupt
    const p3 = enqueue("builder", { kind: "tick", interrupt: true, note: "pick up the phone!" });

    releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(3); // nothing coalesced away
    expect(seen).toContain("pick up the phone!");
  });
});
