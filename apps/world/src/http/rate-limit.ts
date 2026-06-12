// In-memory rate limiting + session caps (design doc §7). The world server is a
// single Node process (the Railway monolith), so in-memory counters are
// sufficient — they reset on restart, which is acceptable for soft abuse limits
// on a portfolio site (HARD RULE: no new deps, no Redis). Everything here is
// pure/testable: the limiter logic is a set of small classes over an injectable
// `now`, and the HTTP layer wires them to real requests.
//
// Limits (design §7):
//   - chat messages: 8/min AND 150/day per visitor
//   - visitor creation: 5/hour per IP (validated-existing visitors are exempt —
//     enforced at the call site, not here)
//   - SSE: 2 concurrent per IP + 200 global
//   - 40-turn session cap (agent gets a wrap-up operator note at ~36)
//
// 429s carry in-fiction copy (design §7 "429s get in-fiction copy with a
// recovery path"). The copy lives in IN_FICTION_429 so the HTTP layer and tests
// share one source.

// --- in-fiction 429 copy ----------------------------------------------------
// Kept warm + in-world: the town is a place, not an API. Each line nudges the
// visitor to a recovery path rather than scolding them.
export const IN_FICTION_429 = {
  chatPerMinute:
    "Whoa — you're talking faster than the town can keep up. Give it a breath and try again in a minute.",
  chatPerDay:
    "You've had quite a day in town. The agents need to rest their voices — come back tomorrow and pick up where you left off.",
  visitorCreate:
    "The gate's seen a lot of new faces from your corner just now. Give it an hour and wander back in.",
  sseConcurrent:
    "Looks like you've already got a window open onto the town. Close one of your other tabs to look in from here.",
  sseGlobal:
    "The town square is packed right now — more visitors than usual. Try again in a little while; the place isn't going anywhere.",
} as const;

// --- session turn cap (design §7: 40-turn max, wrap-up note at ~36) ---------
export const SESSION_TURN_CAP = 40;
export const SESSION_WRAP_UP_AT = 36;

// The in-character operator note injected at the wrap-up threshold so the agent
// lands the goodbye in its own voice rather than the conversation hard-stopping.
export const SESSION_WRAP_UP_NOTE =
  "[operator note] This conversation has been going for a while and is about to wind down. " +
  "Start bringing it to a natural close in your own voice over the next message or two — " +
  "a warm sign-off, an invitation to come find you again, whatever fits the moment. Don't announce a limit.";

// Decide what to do given how many visitor turns have already happened in a
// session (count = number of visitor messages already sent BEFORE this one).
// Pure so the threshold logic is unit-testable.
//   - `block`   → the cap is reached; reject the turn (in-fiction).
//   - `wrapUp`  → at/over the soft threshold; inject the wrap-up operator note.
export function sessionTurnDecision(priorVisitorTurns: number): {
  block: boolean;
  wrapUp: boolean;
} {
  if (priorVisitorTurns >= SESSION_TURN_CAP) return { block: true, wrapUp: false };
  return { block: false, wrapUp: priorVisitorTurns >= SESSION_WRAP_UP_AT - 1 };
}

// --- sliding-window counter -------------------------------------------------
// A minimal sliding-window limiter: records hit timestamps per key, prunes
// anything older than the window on each check. For our volumes (a handful of
// visitors, single process) the per-key arrays stay tiny; we also cap retained
// timestamps at `limit` so a hot key can't grow unbounded.
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // Returns true if the hit is ALLOWED (and records it); false if it would
  // exceed the limit within the window (nothing recorded).
  hit(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  // Drop keys whose every timestamp has aged out (called on a sweep so the maps
  // don't grow with one-off IPs/visitors over a long soak).
  sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, arr] of this.hits) {
      const live = arr.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  // Test seam.
  _size(): number {
    return this.hits.size;
  }
}

// --- concurrent counter (SSE connections) -----------------------------------
// Tracks live connection counts per key plus a global total. acquire() returns a
// release fn or null when a cap is hit; the SSE handler calls release on abort.
export class ConcurrencyLimiter {
  private readonly perKey = new Map<string, number>();
  private total = 0;
  constructor(
    private readonly perKeyMax: number,
    private readonly globalMax: number,
  ) {}

  // Outcome distinguishes which cap was hit so the HTTP layer can pick the right
  // in-fiction copy.
  acquire(key: string): { ok: true; release: () => void } | { ok: false; reason: "per-key" | "global" } {
    if (this.total >= this.globalMax) return { ok: false, reason: "global" };
    const cur = this.perKey.get(key) ?? 0;
    if (cur >= this.perKeyMax) return { ok: false, reason: "per-key" };
    this.perKey.set(key, cur + 1);
    this.total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // idempotent — abort can fire more than once
        released = true;
        const n = (this.perKey.get(key) ?? 1) - 1;
        if (n <= 0) this.perKey.delete(key);
        else this.perKey.set(key, n);
        this.total = Math.max(0, this.total - 1);
      },
    };
  }

  // Test seams.
  _total(): number {
    return this.total;
  }
  _forKey(key: string): number {
    return this.perKey.get(key) ?? 0;
  }
}

// --- the bundle the HTTP layer constructs once ------------------------------
// One object so createApp() builds a single set of limiters shared across all
// requests for the process lifetime (per the design's per-process semantics).
export interface RateLimiters {
  chatPerMinute: SlidingWindow; // 8 / 60s per visitor
  chatPerDay: SlidingWindow; // 150 / 24h per visitor
  visitorCreate: SlidingWindow; // 5 / 1h per IP
  sse: ConcurrencyLimiter; // 2 per IP + 200 global
}

export function createRateLimiters(): RateLimiters {
  return {
    chatPerMinute: new SlidingWindow(8, 60_000),
    chatPerDay: new SlidingWindow(150, 24 * 60 * 60_000),
    visitorCreate: new SlidingWindow(5, 60 * 60_000),
    sse: new ConcurrencyLimiter(2, 200),
  };
}

// Resolve the client IP for per-IP limits, X-Forwarded-For aware (design §7).
// Railway terminates TLS at an edge proxy, so the real client IP is the FIRST
// entry of X-Forwarded-For (the proxy appends; the leftmost is the originator).
// Falls back to a provided socket address, then a constant so a missing IP still
// shares ONE bucket rather than every request getting its own (which would
// disable the limit entirely).
export function clientIp(xForwardedFor: string | undefined, socketAddr: string | undefined): string {
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  if (socketAddr) return socketAddr;
  return "unknown";
}

// Parse a comma-separated CORS allowlist into a normalized origin set (design
// §7). Empty / unset → null (the caller applies the localhost dev default).
// Trailing slashes are stripped so "https://x.com/" and "https://x.com" match.
export function parseCorsOrigins(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : null;
}
