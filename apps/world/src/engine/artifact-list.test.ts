import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
vi.mock("../db/client.js", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("../db/schema.js");
  return { schema, db: drizzle({ query } as never, { schema }) };
});
vi.mock("./events.js", () => ({ appendEvent: vi.fn() }));
vi.mock("./objects.js", () => ({ attachArtifact: vi.fn(), findObjectAtLocation: vi.fn() }));
const { listArtifacts } = await import("./artifacts.js");
beforeEach(() => query.mockClear());

function lastQuery() {
  const [config, params] = query.mock.calls[0] as unknown as [{ text: string }, unknown[]];
  return { sql: config.text, params };
}

describe("artifact discovery query", () => {
  it("excludes diaries and bulletins before the cap, orders apps first, and preserves agent filtering", async () => {
    await listArtifacts({ scope: "made", agent: "hobby" }, 100);
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/where.*"agent_id" = .*"kind" not in.*order by.*case when.*'interactive'.*updated_at.*limit/s);
    expect(params).toEqual(["hobby", "diary_entry", "bulletin", 100]);
  });

  it("retains explicit diary browsing and existing unscoped behavior", async () => {
    await listArtifacts({ kind: "diary_entry" });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/where.*"kind" = .*order by.*created_at.*limit/s);
    expect(sql).not.toContain("not in");
    expect(params).toEqual(["diary_entry", 100]);
  });

  it("pages the agent inventory by updated time with a deterministic tie breaker", async () => {
    await listArtifacts({ scope: "made", agent: "builder" }, 21, { offset: 20, order: "updated" });
    const { sql, params } = lastQuery();
    expect(sql).toMatch(/where.*"agent_id" = .*"kind" not in.*order by.*"updated_at" desc, .*"id" desc.*limit.*offset/s);
    expect(sql).not.toContain("case when");
    expect(params).toEqual(["builder", "diary_entry", "bulletin", 21, 20]);
  });
});
