import { describe, it, expect } from "vitest";
import { tryAcquire, acquire, isLocked } from "./agent-lock.js";

describe("per-agent lock (verification fix: tick-vs-tick races)", () => {
  it("tryAcquire grants once and refuses a concurrent caller", () => {
    const r1 = tryAcquire("career");
    expect(r1).not.toBeNull();
    expect(isLocked("career")).toBe(true);
    // A second concurrent tick for the same agent is refused (treated as busy).
    expect(tryAcquire("career")).toBeNull();
    r1!();
    expect(isLocked("career")).toBe(false);
    // After release the lock is free again.
    const r2 = tryAcquire("career");
    expect(r2).not.toBeNull();
    r2!();
  });

  it("different agents lock independently", () => {
    const a = tryAcquire("writer");
    const b = tryAcquire("builder");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!();
    b!();
  });

  it("acquire() waits for the holder, then runs (FIFO)", async () => {
    const order: string[] = [];
    const r1 = await acquire("hobby");
    const second = acquire("hobby").then((rel) => {
      order.push("second");
      rel();
    });
    // second is queued behind r1; it hasn't run yet.
    order.push("first");
    r1();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  it("release is idempotent (double-call is a no-op)", () => {
    const r = tryAcquire("researcher");
    r!();
    r!(); // must not throw or unlock a later holder
    const r2 = tryAcquire("researcher");
    expect(r2).not.toBeNull();
    r2!();
  });
});
