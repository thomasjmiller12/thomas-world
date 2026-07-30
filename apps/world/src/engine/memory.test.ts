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
  MAX_TOTAL_CHARS,
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

  it("allows a file exactly at the per-file cap (boundary is inclusive)", async () => {
    await expect(
      memCreate("career", "/memories/exact.md", "x".repeat(MAX_FILE_CHARS)),
    ).resolves.toBe("created /memories/exact.md");
  });

  // The per-file cap error used to just say "file exceeds N char cap," which
  // read as "trim this file" — that's the exact phrasing that produced Career
  // Thomas telling a visitor his memory was "capped out — need to trim before
  // adding more" while the total budget sat mostly empty. The fix is naming
  // the actual remedy (another file) instead of implying lossy compression.
  it("suggests splitting into another file when the per-file cap is hit", async () => {
    await expect(
      memCreate("career", "/memories/big.md", "x".repeat(MAX_FILE_CHARS + 1)),
    ).rejects.toThrow(/split this into another file.*\/memories\/people\//i);
  });

  // Three files, each comfortably under MAX_FILE_CHARS, whose first two
  // thirds sum to exactly (MAX_TOTAL_CHARS - third): this is derived from the
  // exported constants (not hardcoded chars) so it stays correct if the caps
  // are rebalanced again, as long as splitting the total three ways still
  // fits under the per-file cap — true both before and after this change
  // (that's the whole point of raising MAX_FILE_CHARS: reaching the total
  // now takes several files, not one).
  const third = Math.floor(MAX_TOTAL_CHARS / 3);
  const remainder = MAX_TOTAL_CHARS - 2 * third; // what's left after two `third`-sized files

  it("enforces the total cap across multiple files even when each is under the per-file cap", async () => {
    await memCreate("builder", "/memories/a.md", "x".repeat(third));
    await memCreate("builder", "/memories/b.md", "x".repeat(third));
    await expect(
      memCreate("builder", "/memories/c.md", "x".repeat(remainder + 1)), // one over the total
    ).rejects.toThrow(/char cap/i);
  });

  it("allows total usage exactly at the total cap (boundary is inclusive)", async () => {
    await memCreate("builder", "/memories/a.md", "x".repeat(third));
    await memCreate("builder", "/memories/b.md", "x".repeat(third));
    await expect(
      memCreate("builder", "/memories/c.md", "x".repeat(remainder)), // exactly the total
    ).resolves.toBe("created /memories/c.md");
  });

  // Unlike the per-file cap, there's no "move it to another file" fix once
  // the TOTAL is full — pruning is the honest instruction here, so the two
  // error messages should read differently.
  it("suggests pruning (not splitting) when the total cap is hit", async () => {
    await memCreate("writer", "/memories/a.md", "x".repeat(third));
    await memCreate("writer", "/memories/b.md", "x".repeat(third));
    await expect(
      memCreate("writer", "/memories/c.md", "x".repeat(remainder + 1)),
    ).rejects.toThrow(/prune something stale/i);
  });

  it("rejects path traversal", async () => {
    await expect(memCreate("career", "../../etc/passwd", "x")).rejects.toThrow(/\.\./);
  });
});
