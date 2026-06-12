import { describe, it, expect } from "vitest";
import {
  SlidingWindow,
  ConcurrencyLimiter,
  clientIp,
  parseCorsOrigins,
  sessionTurnDecision,
  SESSION_TURN_CAP,
  SESSION_WRAP_UP_AT,
} from "./rate-limit.js";

describe("SlidingWindow", () => {
  it("allows up to the limit within the window, then blocks", () => {
    const w = new SlidingWindow(3, 1000);
    expect(w.hit("a", 0)).toBe(true);
    expect(w.hit("a", 100)).toBe(true);
    expect(w.hit("a", 200)).toBe(true);
    expect(w.hit("a", 300)).toBe(false); // 4th within window
  });

  it("frees a slot once the oldest hit ages out of the window", () => {
    const w = new SlidingWindow(2, 1000);
    expect(w.hit("a", 0)).toBe(true);
    expect(w.hit("a", 500)).toBe(true);
    expect(w.hit("a", 600)).toBe(false);
    // At t=1001 the t=0 hit has expired → one slot frees up.
    expect(w.hit("a", 1001)).toBe(true);
  });

  it("scopes counts per key", () => {
    const w = new SlidingWindow(1, 1000);
    expect(w.hit("a", 0)).toBe(true);
    expect(w.hit("b", 0)).toBe(true); // different key, own budget
    expect(w.hit("a", 0)).toBe(false);
  });

  it("sweep drops keys whose hits have all aged out", () => {
    const w = new SlidingWindow(5, 1000);
    w.hit("a", 0);
    expect(w._size()).toBe(1);
    w.sweep(2000);
    expect(w._size()).toBe(0);
  });
});

describe("ConcurrencyLimiter", () => {
  it("enforces the per-key cap and releases on release()", () => {
    const c = new ConcurrencyLimiter(2, 100);
    const a1 = c.acquire("ip");
    const a2 = c.acquire("ip");
    expect(a1.ok && a2.ok).toBe(true);
    const a3 = c.acquire("ip");
    expect(a3.ok).toBe(false);
    if (!a3.ok) expect(a3.reason).toBe("per-key");
    if (a1.ok) a1.release();
    expect(c.acquire("ip").ok).toBe(true);
  });

  it("enforces the global cap across keys", () => {
    const c = new ConcurrencyLimiter(5, 2);
    expect(c.acquire("a").ok).toBe(true);
    expect(c.acquire("b").ok).toBe(true);
    const over = c.acquire("c");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("global");
  });

  it("release is idempotent (abort can fire twice)", () => {
    const c = new ConcurrencyLimiter(1, 10);
    const a = c.acquire("ip");
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release(); // no underflow
    }
    expect(c._total()).toBe(0);
    expect(c._forKey("ip")).toBe(0);
  });
});

describe("clientIp", () => {
  it("prefers the leftmost X-Forwarded-For entry", () => {
    expect(clientIp("1.2.3.4, 5.6.7.8", "10.0.0.1")).toBe("1.2.3.4");
  });
  it("falls back to the socket address when XFF is absent", () => {
    expect(clientIp(undefined, "10.0.0.1")).toBe("10.0.0.1");
  });
  it("falls back to a shared bucket when nothing is known", () => {
    expect(clientIp(undefined, undefined)).toBe("unknown");
  });
});

describe("parseCorsOrigins", () => {
  it("returns null when unset/empty so the caller applies its default", () => {
    expect(parseCorsOrigins(undefined)).toBeNull();
    expect(parseCorsOrigins("")).toBeNull();
    expect(parseCorsOrigins("  , ,")).toBeNull();
  });
  it("splits, trims, and strips trailing slashes", () => {
    expect(parseCorsOrigins("https://a.com/, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});

describe("sessionTurnDecision", () => {
  it("does not wrap up or block early in a conversation", () => {
    expect(sessionTurnDecision(0)).toEqual({ block: false, wrapUp: false });
    expect(sessionTurnDecision(10)).toEqual({ block: false, wrapUp: false });
  });
  it("starts the wrap-up note as it nears the soft threshold", () => {
    // The note fires so the NEXT turn (priorTurns+1) lands at/over SESSION_WRAP_UP_AT.
    expect(sessionTurnDecision(SESSION_WRAP_UP_AT - 1).wrapUp).toBe(true);
    expect(sessionTurnDecision(SESSION_WRAP_UP_AT).wrapUp).toBe(true);
  });
  it("blocks once the hard cap is reached", () => {
    expect(sessionTurnDecision(SESSION_TURN_CAP - 1).block).toBe(false);
    expect(sessionTurnDecision(SESSION_TURN_CAP)).toEqual({ block: true, wrapUp: false });
    expect(sessionTurnDecision(SESSION_TURN_CAP + 5).block).toBe(true);
  });
});
