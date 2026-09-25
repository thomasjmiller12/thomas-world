import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentId, WorldEvent } from "@town/contract";
import type { AgentInput } from "../runtime/queue.js";

// Reuse the local integration-test connection, with all data in a unique schema.
// No model, memory service, mail, or external-network calls are used.
const testUrl = process.env.ROOM_CHAT_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("ringing-object pickup against Postgres", () => {
  const schemaName = `answer_test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let client: typeof import("../db/client.js");
  let objects: typeof import("./objects.js");
  let director: typeof import("../runtime/director.js");
  let app: ReturnType<typeof import("../http/app.js").createApp>;
  let unsubscribe: (() => void) | undefined;
  const emitted: WorldEvent[] = [];
  const inputs: { agent: AgentId; input: AgentInput }[] = [];

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("ROOM_CHAT_TEST_DATABASE_URL must use a local isolated Postgres instance");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    vi.stubEnv("DATABASE_URL", url.toString());
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HINDSIGHT_URL", "RESEND_API_KEY", "VAULT_DIR", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY", "GITHUB_TOKEN"]) {
      vi.stubEnv(key, "");
    }
    vi.resetModules();
    client = await import("../db/client.js");
    const journal = JSON.parse(await readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries) {
      const migration = await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.pool.query(statement.replaceAll('"public".', `"${schemaName}".`));
      }
    }
    objects = await import("./objects.js");
    director = await import("../runtime/director.js");
    app = (await import("../http/app.js")).createApp();
    const queue = await import("../runtime/queue.js");
    queue.registerExecutor(async (agent, input) => { inputs.push({ agent, input }); return { ran: true }; });
    unsubscribe = (await import("./bus.js")).subscribe((event) => emitted.push(event));
    await client.db.insert(client.schema.locations).values({
      id: "park", name: "Park", description: "Test park", adjacency: [],
      fixtures: [{ id: "payphone", kind: "device", actions: ["ring", "answer"] }],
    });
    await client.db.insert(client.schema.visitors).values({
      id: "answer-visitor", name: "Phone tester", visitorToken: "local-token", locationId: "park",
    });
  });

  afterAll(async () => {
    unsubscribe?.();
    if (client) await client.pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    director._resetPendingCalls();
    (await import("../runtime/fixtures.js"))._resetEffectLimiter();
    inputs.length = 0;
    emitted.length = 0;
    await client.pool.query("DELETE FROM world_events");
    await client.pool.query("DELETE FROM world_objects");
    await client.db.insert(client.schema.worldObjects).values({
      id: "park.payphone", displayName: "payphone", locationId: "park", zone: "entrance",
      kind: "device", affordances: ["ring", "answer"], state: { ringing: true, color: "red" },
    });
  });

  const answerEvents = () => emitted.filter((event) => event.type === "object.state_changed" && event.payload.effect === "answered");
  const answerNotes = () => inputs.filter(({ input }) => input.kind === "tick" && input.note?.includes("answered"));
  const visitorPickup = () => app.request("/visitors/answer-visitor/interact", {
    method: "POST", headers: { "content-type": "application/json", "x-visitor-token": "local-token" },
    body: JSON.stringify({ locationId: "park", fixture: "payphone" }),
  });

  it("lets exactly one concurrent claimant clear the ringing and emit its event", async () => {
    const claims = await Promise.all([
      objects.clearObjectRinging("park.payphone", "park", "hobby"),
      objects.clearObjectRinging("park.payphone", "park", null),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await objects.getObject("park.payphone"))?.state).toEqual({ ringing: false, color: "red" });
    expect(answerEvents()).toHaveLength(1);
    const persisted = await client.pool.query("SELECT payload FROM world_events WHERE type='object.state_changed'");
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].payload).toEqual(answerEvents()[0].payload);
  });

  it("rejects missing, remote, and non-ringing objects without fabricating a call", async () => {
    expect(await objects.clearObjectRinging("missing", "park", "hobby")).toBe(false);
    expect(await objects.clearObjectRinging("park.payphone", "office", "hobby")).toBe(false);
    await client.pool.query(`UPDATE world_objects SET state='{"ringing":"true"}'`);
    expect(await objects.clearObjectRinging("park.payphone", "park", "hobby")).toBe(false);
    expect(answerEvents()).toHaveLength(0);
  });

  it("rolls back pickup when its durable event cannot be recorded", async () => {
    await client.pool.query("ALTER TABLE world_events ADD CONSTRAINT reject_answer_test CHECK (type <> 'object.state_changed')");
    try {
      await expect(objects.clearObjectRinging("park.payphone", "park", "hobby")).rejects.toThrow();
      expect((await objects.getObject("park.payphone"))?.state.ringing).toBe(true);
      expect(answerEvents()).toHaveLength(0);
    } finally {
      await client.pool.query("ALTER TABLE world_events DROP CONSTRAINT reject_answer_test");
    }
  });

  it("shares the one-shot caller between competing visitor and agent pickup", async () => {
    await director.playBeat({ agentId: "builder", location: "park" }, { beat: "fixture-effect", params: { effect: "ring" } });
    const pickups = await Promise.all([
      director.answerRingingFixture("park.payphone", "park", null),
      director.answerRingingFixture("park.payphone", "park", "hobby"),
    ]);
    expect(pickups.filter((result) => result.answered)).toHaveLength(1);
    expect(pickups.filter((result) => result.caller === "builder")).toHaveLength(1);
    expect(director.consumePendingCall("park.payphone")).toBeNull();
    expect(answerEvents()).toHaveLength(1);
  });

  it("the visitor route claims the phone, wakes its caller, and leaves a later agent an honest miss", async () => {
    await director.playBeat({ agentId: "builder", location: "park" }, { beat: "fixture-effect", params: { effect: "ring" } });
    expect((await visitorPickup()).status).toBe(200);
    await vi.waitFor(() => expect(answerNotes()).toHaveLength(1));
    expect(answerNotes()[0].agent).toBe("builder");
    const reply = await director.playBeat({ agentId: "hobby", location: "park" }, {
      beat: "fixture-effect", object: "payphone", params: { effect: "answer" },
    });
    expect(reply).toContain("isn't ringing");
    expect(answerEvents()).toHaveLength(1);
    expect(answerNotes()).toHaveLength(1);
  });

  it("an agent answers through the production beat without inventing a caller after restart", async () => {
    const reply = await director.playBeat({ agentId: "hobby", location: "park" }, {
      beat: "fixture-effect", params: { effect: "answer" },
    });
    expect(reply).toContain("No caller is waiting");
    expect(answerEvents()).toHaveLength(1);
    expect(inputs).toHaveLength(0);
  });
});
