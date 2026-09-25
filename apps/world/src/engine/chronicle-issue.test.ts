import { describe, it, expect, vi } from "vitest";
import type { ChronicleItem } from "@town/contract";
import {
  buildSourcePacket,
  fallbackIssue,
  generateWithCitationRepair,
  parseGeneratedIssueText,
} from "./chronicle-issue.js";

// Pure-function coverage for the Town Crier source packet + deterministic
// fallback (the LLM generation path needs a live model + DB and is covered by
// the soak, not unit tests).

const day = "2026-06-20";

const items: ChronicleItem[] = [
  {
    kind: "thread",
    id: "thr-cafe-1",
    ts: "2026-06-20T10:00:00.000Z",
    locationId: "cafe",
    participants: ["writer", "hobby"],
    summary: "Riffing on a side project.",
    turns: [
      { agent: "writer", to: "hobby", text: "what are you building?", ts: "2026-06-20T10:00:00.000Z" },
      { agent: "hobby", text: "a tiny synth", ts: "2026-06-20T10:00:05.000Z" },
      { agent: "writer", text: "love it", ts: "2026-06-20T10:00:10.000Z" },
    ],
  },
  {
    kind: "artifact",
    id: "art-1",
    ts: "2026-06-20T11:00:00.000Z",
    action: "created",
    artifact: {
      id: "art-uuid",
      agentId: "builder",
      kind: "project_log",
      title: "Town Crier prototype",
      locationId: "workshop",
      fixture: "monitor",
      createdAt: "2026-06-20T11:00:00.000Z",
      updatedAt: "2026-06-20T11:00:00.000Z",
      published: false,
    },
  },
  {
    kind: "bulletin",
    id: "bul-1",
    ts: "2026-06-20T12:00:00.000Z",
    agent: "career",
    title: "Open office hours",
    artifactId: "bulletin-uuid",
  },
];

describe("buildSourcePacket", () => {
  it("includes artifact, bulletin, and thread sources with stable ids", () => {
    const bodies = new Map([["art-uuid", "# Notes\nBuilt the packet builder today."]]);
    const packet = buildSourcePacket(day, items, bodies);
    expect(packet.sources.length).toBe(3);
    // ids are S1..Sn in ts order
    expect(packet.sourceIds).toEqual(["S1", "S2", "S3"]);
    const kinds = packet.sources.map((s) => s.kind).sort();
    expect(kinds).toEqual(["artifact", "bulletin", "thread"]);
    // artifact excerpt is derived from the body (markdown stripped)
    const art = packet.sources.find((s) => s.kind === "artifact")!;
    expect(art.targetId).toBe("art-uuid");
    expect(art.excerpt).toContain("Built the packet builder");
    expect(packet.counts.artifacts).toBe(1);
    expect(packet.counts.threads).toBe(1);
    expect(packet.counts.bulletins).toBe(1);
  });

  it("is empty for a day with no items", () => {
    const packet = buildSourcePacket(day, [], new Map());
    expect(packet.sources).toEqual([]);
    expect(packet.sourceIds).toEqual([]);
  });
});

describe("fallbackIssue", () => {
  it("builds a deterministic, fully-cited issue from the packet", () => {
    const packet = buildSourcePacket(day, items, new Map());
    const issue = fallbackIssue(day, packet);
    expect(issue.status).toBe("fallback");
    expect(issue.citations.length).toBeGreaterThan(0);
    // every citation resolves to a real source id
    const ids = new Set(packet.sourceIds);
    for (const cit of issue.citations) expect(ids.has(cit.id)).toBe(true);
  });

  it("returns an empty issue when there are no sources", () => {
    const packet = buildSourcePacket(day, [], new Map());
    const issue = fallbackIssue(day, packet);
    expect(issue.status).toBe("empty");
    expect(issue.citations).toEqual([]);
  });
});

function generatedJson(citationId = "S1") {
  return JSON.stringify({
    title: "A Tiny Synth Finds Its First Audience",
    subtitle: "Writer and Hobby traded ideas at the cafe.",
    lead: {
      bodyMd: `A small instrument took shape over coffee. [${citationId}]`,
      citationIds: [citationId],
    },
    sections: [],
  });
}

describe.each(["anthropic", "openai"] as const)(
  "provider-neutral generated issue parsing (%s fixture)",
  (provider) => {
    const packet = buildSourcePacket(day, items, new Map());

    it("accepts valid bare JSON", () => {
      expect(parseGeneratedIssueText(generatedJson(), packet.sourceIds)).toMatchObject({
        title: "A Tiny Synth Finds Its First Audience",
      });
    });

    it("accepts fenced JSON", () => {
      const text = `Here is the issue:\n\n\`\`\`json\n${generatedJson()}\n\`\`\``;
      expect(parseGeneratedIssueText(text, packet.sourceIds).lead.citationIds).toEqual(["S1"]);
    });

    it("rejects invalid schema output", () => {
      expect(() =>
        parseGeneratedIssueText(JSON.stringify({ title: 42 }), packet.sourceIds),
      ).toThrow();
    });

    it("repairs one invalid citation and preserves the provider's second output", async () => {
      const generate = vi
        .fn<(feedback: string | null) => Promise<string>>()
        .mockResolvedValueOnce(generatedJson("S999"))
        .mockResolvedValueOnce(generatedJson("S1"));

      const issue = await generateWithCitationRepair(packet, generate);

      expect(issue.lead.citationIds).toEqual(["S1"]);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[0][0]).toBeNull();
      expect(generate.mock.calls[1][0]).toContain("unknown citation ids: S999");
      expect(provider).toMatch(/anthropic|openai/);
    });

    it("fails after one repair attempt is exhausted", async () => {
      const generate = vi.fn(async () => generatedJson("S999"));

      await expect(generateWithCitationRepair(packet, generate)).rejects.toThrow(
        "unknown citation ids: S999",
      );
      expect(generate).toHaveBeenCalledTimes(2);
    });
  },
);
