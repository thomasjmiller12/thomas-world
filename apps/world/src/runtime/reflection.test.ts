import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createArtifact: vi.fn(), runTurn: vi.fn(), startTrace: vi.fn(() => ({ end: vi.fn() })),
  remember: vi.fn(), recall: vi.fn(), recent: vi.fn(),
}));
vi.mock("./llm/provider.js", () => ({ hasLlm: () => true }));
vi.mock("./roles.js", () => ({ getProfile: () => ({ role: { tickModel: { provider: "openai", model: "test" } } }), soulGitHash: () => "test" }));
vi.mock("../engine/memory.js", () => ({ coreMemorySnapshot: async () => "" }));
vi.mock("../engine/artifacts.js", () => ({ recentArtifactsBy: async () => [], createArtifact: mocks.createArtifact }));
vi.mock("./hindsight.js", () => ({ remember: mocks.remember, recall: mocks.recall }));
vi.mock("./pursuits.js", () => ({ renderPursuits: async () => "Resume the real artifact; verify its current version." }));
vi.mock("./tracing.js", () => ({ startTrace: mocks.startTrace }));
vi.mock("./turn.js", () => ({ runTurn: mocks.runTurn }));
vi.mock("./failure-handler.js", () => ({ recordTurnFailure: vi.fn() }));
vi.mock("./tools.js", () => ({ buildReflectionTools: () => [{ name: "memory" }, { name: "read_artifact" }, { name: "update_pursuits" }] }));
vi.mock("../engine/agents.js", () => ({ getAgent: async () => ({ locationId: "park", activity: "resting" }) }));
vi.mock("../engine/events.js", () => ({ recentEventsForAgent: mocks.recent, recentPublicWorkForAgent: mocks.recent }));
import { runReflection, publicMemoryEvidence } from "./reflection.js";
import { turnContext } from "./turn-context.js";

afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.recent.mockResolvedValue([]);
  mocks.remember.mockResolvedValue({ ok: true, text: "Stored." });
  mocks.recall.mockResolvedValue({ ok: true, text: "A sourced public result." });
});
it("persists the same town date instructed at reflection start even when completion crosses midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T06:59:00Z")); // Sep 22, 23:59 Pacific
  mocks.runTurn.mockImplementation(async (opts) => {
    expect(turnContext(opts.purpose, opts.observedAt)).toContain("Town date: 2026-09-22");
    vi.setSystemTime(new Date("2026-09-23T07:01:00Z"));
    return { refused: false, finalText: "A quiet September 22." };
  });
  expect(await runReflection("writer")).toEqual({ ran: true });
  expect(mocks.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
    title: "Diary — 2026-09-22", body: "A quiet September 22.",
  }));
  expect(mocks.startTrace).toHaveBeenCalledWith("reflection", expect.objectContaining({ sessionId: "2026-09-22" }));
  expect(mocks.runTurn.mock.calls[0][0].inputText).toContain("Resume the real artifact");
  expect(mocks.runTurn.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toEqual(["memory", "read_artifact", "update_pursuits"]);
  expect(mocks.recall).toHaveBeenCalledWith("writer", expect.any(String), 600, { tags: ["town_public"] });
  expect(mocks.remember).not.toHaveBeenCalled();
});

it("archives source-linked real public work before reflection, never diary or private chat", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T05:00:00Z"));
  const ts = "2026-09-25T01:00:00Z";
  mocks.recent.mockResolvedValue([
    { id: "3", ts, type: "artifact.updated", visibility: "public", payload: { kind: "interactive", artifactId: "game", title: "Real game revision" } },
    { id: "2", ts, type: "artifact.created", visibility: "public", payload: { kind: "diary_entry", title: "Diary" } },
    { id: "1", ts, type: "message.sent", visibility: "private", payload: { text: "private visitor content" } },
  ]);
  mocks.runTurn.mockResolvedValue({ refused: false, finalText: "A game was revised." });
  await runReflection("builder");
  expect(mocks.remember).toHaveBeenCalledWith("builder", expect.stringContaining("world_event:3"), "town_public", {
    documentId: "town-public:builder:2026-09-24", observedAt: "2026-09-25T05:00:00.000Z", metadata: { source: "world_events", town_date: "2026-09-24" },
  });
  const retained = mocks.remember.mock.calls[0][1];
  expect(retained).not.toMatch(/Diary|private visitor content/);
  expect(mocks.runTurn.mock.calls[0][0].inputText).toContain("A sourced public result.");
});

it("does not promote unknown visibility, rest, labels, or diaries into episodic progress", () => {
  const ts = "2026-09-25T01:00:00Z";
  expect(publicMemoryEvidence([
    { ts, type: "artifact.updated", payload: { kind: "interactive" } },
    { ts, type: "agent.rested", visibility: "public", payload: {} },
    { ts, type: "agent.activity", visibility: "public", payload: {} },
    { ts, type: "artifact.updated", visibility: "public", payload: { kind: "diary_entry" } },
  ])).toBe("");
});

it("preserves the decision and its full qualification after a long capability request", () => {
  const summary = "Persistent compute and real datasets for meaningful statistical analysis. ".repeat(14);
  const note = "Verified Python execution and common numerical libraries. ".repeat(7) +
    "Persistent hosting, real datasets, and durable file publishing remain unavailable.";
  expect(note.length).toBeLessThanOrEqual(500);
  const evidence = publicMemoryEvidence([{
    id: "42", ts: "2026-09-25T01:00:00Z", type: "capability.resolved", visibility: "public",
    payload: { requestId: "compute-request", agent: "builder", summary, status: "approved", note },
  }]);
  const payload = JSON.parse(evidence.split("capability.resolved ")[1]);
  expect(payload).toMatchObject({ requestId: "compute-request", agent: "builder", status: "approved", note });
  expect(payload.summary.length).toBeLessThan(summary.length);
  expect(evidence).toContain("world_event:42");
});

it("bounds the digest by retaining whole recent decisions, not cutting their qualifications", () => {
  const note = "Verified only the bounded numerical sandbox. ".repeat(9) + "No persistent backend.";
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: String(index), ts: "2026-09-25T01:00:00Z", type: "capability.resolved", visibility: "public",
    payload: { requestId: `request-${index}`, agent: "builder", summary: "request details ".repeat(65), status: "approved", note },
  }));
  const evidence = publicMemoryEvidence(events);
  const lines = evidence.split("\n");
  expect(evidence.length).toBeLessThanOrEqual(6000);
  expect(lines.length).toBeLessThan(12);
  expect(lines.at(-1)).toContain("world_event:19");
  for (const line of lines) {
    expect(JSON.parse(line.split("capability.resolved ")[1])).toMatchObject({ status: "approved", note });
  }
});
