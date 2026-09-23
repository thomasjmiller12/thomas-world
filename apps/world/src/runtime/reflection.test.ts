import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  createArtifact: vi.fn(), runTurn: vi.fn(), startTrace: vi.fn(() => ({ end: vi.fn() })),
}));
vi.mock("./llm/provider.js", () => ({ hasLlm: () => true }));
vi.mock("./roles.js", () => ({ getProfile: () => ({ role: { tickModel: { provider: "openai", model: "test" } } }), soulGitHash: () => "test" }));
vi.mock("../engine/memory.js", () => ({ coreMemorySnapshot: async () => "" }));
vi.mock("../engine/artifacts.js", () => ({ recentArtifactsBy: async () => [], createArtifact: mocks.createArtifact }));
vi.mock("./hindsight.js", () => ({ reflect: async () => {} }));
vi.mock("./tracing.js", () => ({ startTrace: mocks.startTrace }));
vi.mock("./turn.js", () => ({ runTurn: mocks.runTurn }));
vi.mock("./failure-handler.js", () => ({ recordTurnFailure: vi.fn() }));
vi.mock("./tools.js", () => ({ buildCoreMemoryTool: () => ({}) }));
vi.mock("../engine/agents.js", () => ({ getAgent: async () => ({ locationId: "park", activity: "resting" }) }));
vi.mock("../engine/events.js", () => ({ recentEventsForAgent: async () => [] }));
import { runReflection } from "./reflection.js";
import { turnContext } from "./turn-context.js";

afterEach(() => vi.useRealTimers());
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
});
