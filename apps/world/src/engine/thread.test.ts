import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const columns = {
    agentId: { name: "agent_id" },
    provider: { name: "provider" },
  };
  return {
    columns,
    selectWhere: vi.fn(),
    insertValues: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
  and: mocks.and,
}));

vi.mock("../db/client.js", () => ({
  schema: { agentThreads: mocks.columns },
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: mocks.selectWhere })),
    })),
    insert: vi.fn(() => ({
      values: mocks.insertValues.mockImplementation(() => ({
        onConflictDoUpdate: mocks.onConflictDoUpdate,
      })),
    })),
  },
}));

vi.mock("./memory.js", () => ({ coreMemorySnapshot: vi.fn() }));
vi.mock("./artifacts.js", () => ({ listArtifacts: vi.fn() }));

import { loadThread, persistThread, reseedThread } from "./thread.js";

describe("provider-scoped agent threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectWhere.mockResolvedValue([]);
    mocks.onConflictDoUpdate.mockResolvedValue(undefined);
  });

  it("loads only the requested provider row", async () => {
    await expect(loadThread("builder", "openai")).resolves.toEqual({
      items: [],
      inputCursor: null,
    });

    expect(mocks.eq.mock.calls).toEqual([
      [mocks.columns.agentId, "builder"],
      [mocks.columns.provider, "openai"],
    ]);
    expect(mocks.and).toHaveBeenCalledOnce();
  });

  it("upserts with the additive (agent_id, provider) unique key", async () => {
    const items = [{ type: "message", role: "user", content: "hello" }];
    await persistThread("builder", "openai", items, 42);

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "builder",
        provider: "openai",
        content: items,
        inputCursor: 42,
      }),
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [mocks.columns.agentId, mocks.columns.provider],
      }),
    );
  });

  it("reseeds only the selected provider history", async () => {
    await reseedThread("researcher", "anthropic");

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "researcher",
        provider: "anthropic",
        content: [],
        inputCursor: null,
      }),
    );
  });
});
