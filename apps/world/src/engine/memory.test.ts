import { describe, it, expect, beforeEach, vi } from "vitest";

// Memory-tool handler test against a fake in-memory "db". We mock the drizzle
// client so the six memory-tool commands are exercised end-to-end (the storage
// layer Claude's memory tool drives) without a live Postgres. The fake models
// just enough of the query-builder surface that memory.ts uses.

interface Row {
  agentId: string;
  path: string;
  content: string;
  updatedAt: Date;
}

let store: Row[] = [];

// A tiny fake of the drizzle fluent API for the memory_files table. memory.ts
// uses: select().from().where(); insert().values(); update().set().where();
// delete().where(). The where() predicate is built from a sql`` tagged template
// in observation.ts but in memory.ts it's `and(eq, eq)` — we don't interpret
// the predicate, we capture (agentId, path) from the values/sets and filter by
// the most recent eq() args recorded. Simpler: we intercept at the call sites
// by recording the last eq() comparisons.
const eqCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => {
    eqCalls.push([col, val]);
    return { __eq: [col, val] };
  },
  and: (...args: unknown[]) => ({ __and: args }),
  sql: () => ({ __sql: true }),
}));

// Column sentinels so eq() captures map back to fields.
const AGENT_COL = { name: "agentId" };
const PATH_COL = { name: "path" };

vi.mock("../db/client.js", () => {
  const memoryFiles = { agentId: AGENT_COL, path: PATH_COL };
  // Resolve the (agentId, path) filter from the eqCalls captured since the last op.
  function resolveFilter() {
    let agentId: string | undefined;
    let path: string | undefined;
    for (const [col, val] of eqCalls) {
      if (col === AGENT_COL) agentId = val as string;
      if (col === PATH_COL) path = val as string;
    }
    eqCalls.length = 0;
    return { agentId, path };
  }
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              const { agentId, path } = resolveFilter();
              return store.filter(
                (r) =>
                  (agentId === undefined || r.agentId === agentId) &&
                  (path === undefined || r.path === path),
              );
            },
          };
        },
      };
    },
    insert() {
      return {
        values(v: { agentId: string; path: string; content: string }) {
          store.push({ ...v, updatedAt: new Date() });
        },
      };
    },
    update() {
      return {
        set(patch: { content?: string }) {
          return {
            where() {
              const { agentId, path } = resolveFilter();
              for (const r of store) {
                if (r.agentId === agentId && r.path === path && patch.content !== undefined) {
                  r.content = patch.content;
                }
              }
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          const { agentId, path } = resolveFilter();
          store = store.filter((r) => !(r.agentId === agentId && r.path === path));
        },
      };
    },
  };
  return { db, schema: { memoryFiles } };
});

// Import AFTER the mocks are registered.
const {
  memCreate,
  memView,
  memStrReplace,
  memInsert,
  memDelete,
  memRename,
  listMemoryFiles,
  MAX_FILE_CHARS,
} = await import("./memory.js");

describe("memory-tool handler (storage backing betaMemoryTool)", () => {
  beforeEach(() => {
    store = [];
    eqCalls.length = 0;
  });

  it("create then view round-trips with line numbers", async () => {
    await memCreate("career", "/memories/focus.md", "ship the world server\nthen soak it");
    const view = await memView("career", "/memories/focus.md");
    expect(view).toContain("1: ship the world server");
    expect(view).toContain("2: then soak it");
  });

  it("str_replace edits in place and rejects a missing needle", async () => {
    await memCreate("writer", "/memories/n.md", "draft v1");
    await memStrReplace("writer", "/memories/n.md", "v1", "v2");
    expect(await memView("writer", "/memories/n.md")).toContain("draft v2");
    await expect(memStrReplace("writer", "/memories/n.md", "nope", "x")).rejects.toThrow(
      /old_str not found/i,
    );
  });

  it("insert places a line at the given index", async () => {
    await memCreate("builder", "/memories/list.md", "a\nc");
    await memInsert("builder", "/memories/list.md", 1, "b");
    const view = await memView("builder", "/memories/list.md");
    expect(view).toContain("2: b");
  });

  it("rename moves content and removes the old path", async () => {
    await memCreate("hobby", "/memories/old.md", "stuff");
    await memRename("hobby", "/memories/old.md", "/memories/new.md");
    const files = await listMemoryFiles("hobby");
    expect(files.map((f) => f.path)).toContain("/memories/new.md");
    expect(files.map((f) => f.path)).not.toContain("/memories/old.md");
  });

  it("delete removes a file", async () => {
    await memCreate("researcher", "/memories/tmp.md", "x");
    await memDelete("researcher", "/memories/tmp.md");
    expect(await listMemoryFiles("researcher")).toHaveLength(0);
  });

  it("isolates files by agent", async () => {
    await memCreate("career", "/memories/a.md", "career note");
    await memCreate("writer", "/memories/a.md", "writer note");
    const careerFiles = await listMemoryFiles("career");
    expect(careerFiles).toHaveLength(1);
    expect(careerFiles[0].content).toBe("career note");
  });

  it("enforces the per-file char cap", async () => {
    await expect(
      memCreate("career", "/memories/big.md", "x".repeat(MAX_FILE_CHARS + 1)),
    ).rejects.toThrow(/char cap/i);
  });

  it("rejects path traversal", async () => {
    await expect(memCreate("career", "../../etc/passwd", "x")).rejects.toThrow(/\.\./);
  });
});
