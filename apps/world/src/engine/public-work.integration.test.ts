import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";

const connection = process.env.ROOM_CHAT_TEST_DATABASE_URL;
if (connection && !["localhost", "127.0.0.1"].includes(new URL(connection).hostname)) {
  throw new Error("Public work tests require a localhost database");
}
describe.skipIf(!connection)("public memory evidence on Postgres", () => {
  const namespace = `town_work_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: typeof import("../db/client.js").pool;
  let recentPublicWorkForAgent: typeof import("./events.js").recentPublicWorkForAgent;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: connection }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    await admin.query(`CREATE TABLE ${namespace}.world_events (id bigserial PRIMARY KEY, type text NOT NULL, agent_id text, location_id text, visitor_id text, payload jsonb NOT NULL, visibility text NOT NULL, ts timestamptz NOT NULL DEFAULT now())`);
    const url = new URL(connection!); url.searchParams.set("options", `-c search_path=${namespace}`);
    process.env.DATABASE_URL = url.toString();
    ({ pool } = await import("../db/client.js"));
    ({ recentPublicWorkForAgent } = await import("./events.js"));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); }
  });
  it("finds old work behind noisy events and includes only the targeted public capability decision", async () => {
    const insert = (type: string, actor: string | null, payload: object, visibility = "public") =>
      pool.query("INSERT INTO world_events(type,agent_id,payload,visibility) VALUES($1,$2,$3,$4)", [type, actor, payload, visibility]);
    await insert("artifact.updated", "builder", { kind: "interactive", artifactId: "real-game" });
    for (let i = 0; i < 40; i++) await insert("artifact.created", "builder", { kind: "diary_entry" });
    await insert("capability.resolved", null, { agent: "builder", status: "fulfilled", requestId: "repo-access" });
    await insert("capability.resolved", null, { agent: "writer", status: "fulfilled", requestId: "someone-else" });
    await insert("artifact.updated", "builder", { kind: "interactive", text: "private" }, "private");
    const events = await recentPublicWorkForAgent("builder", new Date(Date.now() - 60_000), 2);
    expect(events.map((event) => event.type)).toEqual(["artifact.updated", "capability.resolved"]);
    expect(events[0].payload).toMatchObject({ artifactId: "real-game" });
    expect(events[1].payload).toMatchObject({ requestId: "repo-access" });
  });
});
