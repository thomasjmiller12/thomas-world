import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  row: undefined as { content: string } | undefined,
  write: vi.fn(), getArtifact: vi.fn(), requests: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  schema: { memoryFiles: { agentId: "agent_id", path: "path" } },
  db: {
    select: () => ({ from: () => ({ where: async () => mocks.row ? [mocks.row] : [] }) }),
    insert: () => ({ values: (value: { content: string }) => ({ onConflictDoUpdate: async () => { mocks.write(value); mocks.row = value; } }) }),
  },
}));
vi.mock("../engine/artifacts.js", () => ({ getArtifact: mocks.getArtifact }));
vi.mock("../engine/outside.js", () => ({ capabilityRequestsFor: mocks.requests }));
import { buildPursuitTool, renderPursuits, loadPursuits } from "./pursuits.js";

const pursuit = {
  title: "Improve my game", why: "Make it playable", status: "active" as const,
  nextStep: "Read the latest rules and correct the turn indicator", blocker: "",
  evidence: "Version one is published", artifactIds: ["game"], capabilityRequestIds: [],
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.row = undefined;
  mocks.requests.mockResolvedValue([]);
  mocks.getArtifact.mockResolvedValue({ id: "game", title: "My game", agentId: "builder", kind: "interactive", version: 1, published: true, updatedAt: new Date("2026-09-24T01:00:00Z") });
});

it("persists a working set independently of the thread and rechecks canonical state the next day", async () => {
  const applied = vi.fn();
  await buildPursuitTool("builder").run({ pursuits: [pursuit] }, { markApplied: applied });
  expect(applied).toHaveBeenCalledOnce();
  expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ agentId: "builder", path: "/.pursuits" }));
  const saved = await loadPursuits("builder");
  mocks.getArtifact.mockResolvedValue({ id: "game", title: "My game", agentId: "builder", kind: "interactive", version: 2, published: true, updatedAt: new Date("2026-09-25T01:00:00Z") });
  const nextDay = new Date(Date.parse(saved!.updatedAt) + 86_400_000);
  const rendered = await renderPursuits("builder", nextDay);
  expect(rendered).toContain("correct the turn indicator");
  expect(rendered).toContain("version 2");
  expect(rendered).toContain("2026-09-25T01:00:00.000Z");
  expect(rendered).toContain("remembered intentions, not proof");
});

it("rejects fabricated references and incoherent status without replacing existing focus", async () => {
  const tool = buildPursuitTool("builder");
  mocks.getArtifact.mockResolvedValue(undefined);
  expect(await tool.run({ pursuits: [pursuit] })).toContain("No artifact");
  expect(await tool.run({ pursuits: [{ ...pursuit, artifactIds: [], capabilityRequestIds: ["another-agents-request"] }] })).toContain("belongs to you");
  expect(await tool.run({ pursuits: [{ ...pursuit, status: "blocked", blocker: "" }] })).toContain("actual dependency");
  expect(await tool.run({ pursuits: [{ ...pursuit, status: "done", evidence: "" }] })).toContain("actual result");
  expect(await tool.run({ pursuits: [pursuit, pursuit, pursuit] })).toContain("at most two active");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("surfaces a resolved dependency and an old review date instead of silently accepting an old blocker", async () => {
  const updatedAt = "2026-08-23T01:00:00.000Z";
  mocks.row = { content: JSON.stringify({ updatedAt, pursuits: [{ ...pursuit, status: "blocked", blocker: "Repository access", capabilityRequestIds: ["request"] }] }) };
  mocks.requests.mockResolvedValue([{ id: "request", status: "fulfilled", summary: "Read the repo" }]);
  const rendered = await renderPursuits("builder", new Date("2026-09-25T01:00:00Z"));
  expect(rendered).toContain("request: fulfilled");
  expect(rendered).toContain("more than three days");
});

it("makes damaged state visible without replacing or treating it as completed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.row = { content: "broken JSON" };
  expect(await renderPursuits("builder")).toContain("could not be read");
  expect(mocks.write).not.toHaveBeenCalled();
  warn.mockRestore();
});
