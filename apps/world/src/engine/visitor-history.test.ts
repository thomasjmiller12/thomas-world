// The person tier's pure helpers. The rendering is what actually changes agent
// behaviour ("you've talked 11 times before"), so it's worth pinning precisely.

import { describe, it, expect } from "vitest";
import { agoPhrase } from "./visitor-history.js";
import { renderAcquaintance, renderVisitorsSection } from "../runtime/observation.js";

const NOW = new Date("2026-07-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("agoPhrase", () => {
  it("phrases recent gaps in minutes", () => {
    expect(agoPhrase(ago(30 * 1000), NOW)).toBe("just now");
    expect(agoPhrase(ago(20 * MIN), NOW)).toBe("20 minutes ago");
  });

  it("phrases hours, then yesterday, then days", () => {
    expect(agoPhrase(ago(1 * HOUR), NOW)).toBe("about an hour ago");
    expect(agoPhrase(ago(5 * HOUR), NOW)).toBe("about 5 hours ago");
    expect(agoPhrase(ago(1 * DAY), NOW)).toBe("yesterday");
    expect(agoPhrase(ago(5 * DAY), NOW)).toBe("5 days ago");
  });

  it("phrases the real 17-day gap from the July 13 visit as weeks", () => {
    expect(agoPhrase(ago(17 * DAY), NOW)).toBe("about 2 weeks ago");
  });

  it("phrases long gaps in months", () => {
    expect(agoPhrase(ago(75 * DAY), NOW)).toBe("about 2 months ago");
  });
});

describe("renderAcquaintance", () => {
  it("says NOTHING for a genuine first meeting", () => {
    // A new visitor's line must stay byte-identical to before the person tier,
    // so we never imply a history that doesn't exist.
    expect(renderAcquaintance(undefined)).toBe("");
    expect(renderAcquaintance({ priorSessions: 0, lastSeenAt: null })).toBe("");
  });

  it("singularizes a single prior conversation", () => {
    expect(renderAcquaintance({ priorSessions: 1, lastSeenAt: null })).toBe(
      " — you've talked once before",
    );
  });

  it("reports count and recency together", () => {
    expect(
      renderAcquaintance({ priorSessions: 11, lastSeenAt: new Date(NOW.getTime() - 17 * DAY) }),
    ).toContain("you've talked 11 times before, most recently");
  });
});

describe("renderVisitorsSection with history", () => {
  const arrivals = new Map<string, number>();

  it("marks a returning visitor as known", () => {
    const line = renderVisitorsSection(
      [{ id: "v1", name: "Timtom" }],
      arrivals,
      1,
      NOW.getTime(),
      undefined,
      new Map([["v1", { priorSessions: 11, lastSeenAt: new Date(NOW.getTime() - 17 * DAY) }]]),
    );
    expect(line).toContain("Timtom is here with you");
    expect(line).toContain("you've talked 11 times before");
  });

  it("leaves a first-time visitor's line unchanged when no history is supplied", () => {
    const withoutHistory = renderVisitorsSection(
      [{ id: "v1", name: "Timtom" }],
      arrivals,
      1,
      NOW.getTime(),
    );
    const withEmptyHistory = renderVisitorsSection(
      [{ id: "v1", name: "Timtom" }],
      arrivals,
      1,
      NOW.getTime(),
      undefined,
      new Map([["v1", { priorSessions: 0, lastSeenAt: null }]]),
    );
    expect(withEmptyHistory).toBe(withoutHistory);
  });

  it("still reports an empty room the same way", () => {
    expect(renderVisitorsSection([], arrivals, 0, NOW.getTime(), undefined, new Map())).toBe(
      "No visitors in town right now.",
    );
  });
});
