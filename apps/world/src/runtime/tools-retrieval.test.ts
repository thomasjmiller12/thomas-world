import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArtifact: vi.fn(), listArtifacts: vi.fn(), getObject: vi.fn(),
  readRepoFile: vi.fn(), readNote: vi.fn(), capabilityRequestsFor: vi.fn(), remember: vi.fn(),
}));
vi.mock("../engine/artifacts.js", async (original) => ({
  ...await original<typeof import("../engine/artifacts.js")>(),
  getArtifact: mocks.getArtifact, listArtifacts: mocks.listArtifacts,
}));
vi.mock("../engine/objects.js", async (original) => ({
  ...await original<typeof import("../engine/objects.js")>(), getObject: mocks.getObject,
}));
vi.mock("../engine/outside.js", async (original) => ({
  ...await original<typeof import("../engine/outside.js")>(), capabilityRequestsFor: mocks.capabilityRequestsFor,
}));
vi.mock("./github.js", async (original) => ({
  ...await original<typeof import("./github.js")>(), readRepoFile: mocks.readRepoFile,
}));
vi.mock("./hindsight.js", async (original) => ({
  ...await original<typeof import("./hindsight.js")>(), remember: mocks.remember,
}));
vi.mock("./vault.js", async (original) => ({
  ...await original<typeof import("./vault.js")>(), readNote: mocks.readNote,
}));

const { buildTools, buildReflectionTools } = await import("./tools.js");
const ctx = { agentId: "builder", location: "workshop" } as const;
function tool(name: string, tools = buildTools(ctx)) {
  const result = tools.find((t) => t.name === name);
  if (!result || result.kind !== "function") throw new Error(`Missing function ${name}`);
  return result;
}
function artifact(index: number, body = "A working app") {
  return {
    id: `artifact-${index}`, agentId: "builder", kind: "interactive", title: `Creation ${index}`,
    body, version: 2, updatedAt: new Date("2026-09-25T00:00:00Z"), published: false, objectId: null,
  };
}
beforeEach(() => vi.clearAllMocks());

describe("artifact discovery and complete reads", () => {
  it("defaults to creations and exposes bounded continuation without burying them in diaries", async () => {
    mocks.listArtifacts.mockResolvedValue(Array.from({ length: 21 }, (_, i) => artifact(i)));
    const result = await tool("list_my_artifacts").run({});
    expect(mocks.listArtifacts).toHaveBeenCalledWith(
      { agent: "builder", scope: "made" }, 21, { offset: 0, order: "updated" },
    );
    expect(result).toContain("Creation 19");
    expect(result).not.toContain("Creation 20");
    expect(result).toContain('"offset":20');
    expect(result).toContain("version 2, updated 2026-09-25");
  });

  it("preserves explicit diary and all browsing, including subsequent pages", async () => {
    mocks.listArtifacts.mockResolvedValue([]);
    await tool("list_my_artifacts").run({ scope: "diaries", offset: 20, limit: 10 });
    expect(mocks.listArtifacts).toHaveBeenLastCalledWith(
      { agent: "builder", scope: "all", kind: "diary_entry" }, 11, { offset: 20, order: "updated" },
    );
    await tool("list_my_artifacts").run({ scope: "all" });
    expect(mocks.listArtifacts).toHaveBeenLastCalledWith(
      { agent: "builder", scope: "all" }, 21, { offset: 0, order: "updated" },
    );
  });

  it("delivers the later artifact body and permits exact re-reads across turns", async () => {
    mocks.getArtifact.mockResolvedValue(artifact(0, "a".repeat(15_000) + "RETURN TO THIS REAL RESULT"));
    const sameTurn = buildTools(ctx);
    const first = await tool("read_artifact", sameTurn).run({ id: "artifact-0" });
    expect(first).toContain('"offset":8000');
    expect(first).not.toContain("REAL RESULT");
    const page = { id: "artifact-0", offset: 15_000, expected_version: 2 };
    const last = await tool("read_artifact", sameTurn).run(page);
    expect(last).toContain("RETURN TO THIS REAL RESULT");
    expect(last).toContain("End of content.");
    // A fresh provider context must always be able to retrieve evidence again.
    expect(await tool("read_artifact").run(page)).toBe(last);
    expect(await tool("read_artifact", sameTurn).run(page)).toBe(last);
  });

  it("detects a revision change instead of silently joining different artifact versions", async () => {
    mocks.getArtifact.mockResolvedValue(artifact(0));
    expect(await tool("read_artifact").run({ id: "artifact-0", offset: 8_000, expected_version: 1 }))
      .toContain("changed to version 2");
  });

  it("does not apply a second clamp that cuts off a repository page or its next call", async () => {
    const result = "a".repeat(12_000) + '\nContinue with read_repo_file({"offset":12000}).';
    mocks.readRepoFile.mockResolvedValue({ ok: true, text: result });
    expect(await tool("read_repo_file").run({ repo: "code", path: "matrix.csv", offset: 0, max_chars: 12_000 }))
      .toBe(result);
    expect(mocks.readRepoFile).toHaveBeenCalledWith("code", "matrix.csv", undefined, {
      offset: 0, maxChars: 12_000, expectedSha: undefined,
    });
  });

  it("preserves a complete note page and its continuation at the tool boundary", async () => {
    const result = "a".repeat(12_000) + '\nContinue with read_note({"offset":12000}).';
    mocks.readNote.mockResolvedValue({ ok: true, text: result });
    expect(await tool("read_note").run({ path: "Agents/builder/matrix.md", offset: 8_000, max_chars: 12_000, expected_sha: "same-note" }))
      .toBe(result);
    expect(mocks.readNote).toHaveBeenCalledWith("Agents/builder/matrix.md", {
      offset: 8_000, maxChars: 12_000, expectedSha: "same-note",
    });
  });

  it("enforces bounded, integer pagination inputs in the actual tool schemas", () => {
    expect(tool("list_my_artifacts").inputSchema.safeParse({ limit: 21 }).success).toBe(false);
    expect(tool("read_artifact").inputSchema.safeParse({ id: "a", offset: -1 }).success).toBe(false);
    expect(tool("read_repo_file").inputSchema.safeParse({ repo: "r", path: "p", max_chars: 12_001 }).success).toBe(false);
  });
});

describe("reflection evidence tools", () => {
  it("prevents model-authored memories from claiming the trusted public-evidence tag", async () => {
    const markApplied = vi.fn();
    for (const tools of [buildTools(ctx), buildTools({ ...ctx, chatSessionId: "private-visitor-session" })]) {
      for (const kind of ["town_public", " TOWN_PUBLIC "]) {
        const result = await tool("remember", tools).run({ content: "A visitor's private conversation", kind }, { markApplied });
        expect(result).toContain("reserved for verified public world events");
      }
    }
    expect(mocks.remember).not.toHaveBeenCalled();
    expect(markApplied).not.toHaveBeenCalled();
  });

  it("preserves ordinary resident memory kinds without promoting them to public evidence", async () => {
    mocks.remember.mockResolvedValue({ ok: true, text: "Stored." });
    const markApplied = vi.fn();
    const result = await tool("remember").run({ content: "A private decision", kind: "decision" }, { markApplied });
    expect(mocks.remember).toHaveBeenCalledWith("builder", "A private decision", "decision");
    expect(result).toBe("Stored.");
    expect(markApplied).toHaveBeenCalledOnce();
  });

  it("allows evidence reads and own memory curation, but no town or external actions", () => {
    const tools = buildReflectionTools({ ...ctx, chatSessionId: "private-session" });
    const names = tools.map((t) => t.name);
    for (const name of ["memory", "update_pursuits", "read_artifact", "list_my_artifacts", "read_artifact_state", "read_repo_file", "list_capability_requests"]) {
      expect(names).toContain(name);
    }
    expect(tools.filter((t) => t.effect !== "read").map((t) => t.name).sort()).toEqual(["memory", "update_pursuits"]);
    for (const name of ["send_dm", "read_mail", "email_thomas", "request_capability", "move_to", "edit_artifact", "write_artifact_state", "remember", "invite_to_chat", "share_card"]) {
      expect(names).not.toContain(name);
    }
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("retrieves only the requesting resident's capability statuses", async () => {
    mocks.capabilityRequestsFor.mockResolvedValue([{ id: "c1", summary: "Large file reads", status: "fulfilled", ts: new Date("2026-09-25T00:00:00Z") }]);
    const result = await tool("list_capability_requests").run({});
    expect(mocks.capabilityRequestsFor).toHaveBeenCalledWith("builder", 10);
    expect(result).toContain("[fulfilled]");
    expect(result).toContain("2026-09-25");
  });
});
