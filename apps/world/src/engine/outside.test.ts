// The capability-request receipt — the whole feedback loop, in one string.
//
// Until 2026-08-02 request_capability inserted a row, emitted an event, and told
// the agent "Thomas will see it." None of that was true: no email was sent, no
// endpoint read the table, and nothing anywhere writes the `status` column. Nine
// requests accumulated unseen between 2026-06-12 and 2026-08-02 — and because no
// acknowledgement ever came back, agents re-filed asks they'd already made
// (Builder asked for a Python sandbox twice, seven weeks apart).

import { describe, it, expect } from "vitest";
import { formatCapabilityReceipt } from "./outside.js";

const base = { id: "req-1", description: "A Python sandbox", emailed: true, alreadyOpen: [] };

describe("formatCapabilityReceipt", () => {
  it("confirms the email actually went out", () => {
    const out = formatCapabilityReceipt(base);
    expect(out).toContain("email just went out to Thomas");
    expect(out).toContain("req-1");
  });

  it("says queued — not 'Thomas will see it' — when the mail line is down", () => {
    const out = formatCapabilityReceipt({ ...base, emailed: false });
    expect(out).toContain("queued");
    expect(out).not.toContain("just went out");
  });

  it("lists the agent's other open requests so it stops re-filing", () => {
    const out = formatCapabilityReceipt({
      ...base,
      alreadyOpen: [{ summary: "A Python code sandbox — an environment where I can run scripts" }],
    });
    expect(out).toContain("don't re-file these");
    expect(out).toContain("A Python code sandbox");
  });

  it("says nothing about a backlog when there isn't one", () => {
    expect(formatCapabilityReceipt(base)).not.toContain("Still open");
  });

  it("keeps multi-line summaries to their first line, clamped", () => {
    const out = formatCapabilityReceipt({
      ...base,
      description: `${"x".repeat(200)}\nsecond line`,
      alreadyOpen: [{ summary: `${"y".repeat(200)}\nsecond line` }],
    });
    expect(out).not.toContain("second line");
    expect(out).toContain("…");
  });
});
