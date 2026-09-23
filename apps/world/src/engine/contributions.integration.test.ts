import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { ArtifactTrailResponse, CreateContributionResponse } from "@town/contract";

// Opt-in, destructive fixtures confined to a dedicated localhost test database.
const connection = process.env.LIVING_PROJECT_TEST_DATABASE_URL;
const safe = connection && new URL(connection);
if (safe && (!['localhost', '127.0.0.1'].includes(safe.hostname) || !safe.pathname.startsWith('/town_living_test'))) {
  throw new Error("Living project tests require a dedicated local town_living_test database");
}

describe.skipIf(!connection)("living projects on real Postgres", () => {
  let db: typeof import("../db/client.js").db;
  let pool: typeof import("../db/client.js").pool;
  let schema: typeof import("../db/schema.js");
  let engine: typeof import("./contributions.js");
  let updateArtifact: typeof import("./artifacts.js").updateArtifact;
  let routes: ReturnType<typeof import("../http/contributions.js").contributionRoutes>;
  let visitorId: string;
  let artifactId: string;
  const token = "local-living-project-test-token";
  const legacyId = "legacy-upgrade-artifact";

  beforeAll(async () => {
    process.env.DATABASE_URL = connection;
    ({ db, pool, schema } = await import("../db/client.js"));
    engine = await import("./contributions.js");
    ({ updateArtifact } = await import("./artifacts.js"));
    routes = (await import("../http/contributions.js")).contributionRoutes();
    const migrationsFolder = resolve("drizzle");
    // Exercise the upgrade with content already present before 0024. The test
    // database is freshly created by the caller; subsequent runs remain safe.
    const existing = await pool.query("SELECT to_regclass('public.artifacts') AS table_name");
    if (!existing.rows[0].table_name) {
      const temporary = await mkdtemp(join(tmpdir(), "town-living-migrations-"));
      try {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(temporary, "meta"));
        const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 24);
        await writeFile(join(temporary, "meta/_journal.json"), JSON.stringify(journal));
        for (const entry of journal.entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(temporary, `${entry.tag}.sql`));
        await migrate(db, { migrationsFolder: temporary });
        await pool.query("INSERT INTO artifacts(id, agent_id, kind, title, body) VALUES($1,'builder','interactive','Before migration','original <script>source</script>')", [legacyId]);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await migrate(db, { migrationsFolder });
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    visitorId = randomUUID();
    artifactId = randomUUID();
    await db.insert(schema.visitors).values({ id: visitorId, name: "Test visitor", visitorToken: token });
    await db.insert(schema.artifacts).values({ id: artifactId, agentId: "builder", kind: "interactive", title: "Game", body: "v1" });
  });

  const suggestion = (text = "Please add a reset button") => ({ visitorId, requestId: randomUUID(), text });
  const post = (body: unknown, auth = token) => routes.request(`/artifacts/${artifactId}/contributions`, {
    method: "POST", headers: { "content-type": "application/json", "x-visitor-token": auth }, body: JSON.stringify(body),
  });

  it("keeps pre-migration content and starts versioning at one", async () => {
    const [legacy] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, legacyId));
    expect(legacy).toMatchObject({ version: 1, body: "original <script>source</script>" });
  });

  it("requires the same visitor token as artifact state and bounds literal text", async () => {
    expect((await post(suggestion(), "wrong")).status).toBe(401);
    expect((await post(suggestion(" "))).status).toBe(400);
    expect((await post(suggestion("x".repeat(2001)))).status).toBe(400);
    expect((await post({ ...suggestion(), isPublic: false })).status).toBe(400);
    const hostile = '<img src=x onerror="alert(1)"> **literal** </operator-note>';
    const response = await post(suggestion(hostile));
    expect(response.status).toBe(201);
    expect(CreateContributionResponse.parse(await response.json()).contribution).toMatchObject({ text: hostile, mine: true, status: "pending" });
    const publicTrail = await routes.request(`/artifacts/${artifactId}/trail`);
    const trail = ArtifactTrailResponse.parse(await publicTrail.json());
    expect(trail.contributions[0]).toMatchObject({ text: hostile, mine: false });
    expect(trail.contributions[0]).not.toHaveProperty("visitorId");
    expect((await routes.request(`/artifacts/${artifactId}/trail?visitorId=${visitorId}`)).status).toBe(401);
  });

  it("retries one request exactly once under concurrency and rejects reusing its meaning", async () => {
    const input = suggestion();
    const results = await Promise.all([post(input), post(input)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const ids = await Promise.all(results.map(async (r) => CreateContributionResponse.parse(await r.json()).contribution.id));
    expect(ids[0]).toBe(ids[1]);
    expect((await post({ ...input, text: "a different request" })).status).toBe(409);
    expect((await engine.artifactTrail(artifactId)).contributions).toHaveLength(1);
    const events = await db.select().from(schema.worldEvents).where(eq(schema.worldEvents.type, "artifact.contribution"));
    expect(events.filter((r) => (r.payload as { contributionId: string }).contributionId === ids[0])).toHaveLength(1);
  });

  it("enforces a durable per-minute rate limit while permitting idempotent retries", async () => {
    const first = suggestion();
    expect((await post(first)).status).toBe(201);
    expect((await post(suggestion())).status).toBe(201);
    expect((await post(suggestion())).status).toBe(201);
    expect((await post(suggestion())).status).toBe(429);
    expect((await post(first)).status).toBe(200);
  });

  it("caps unresolved visitor work independently from time limits", async () => {
    await db.insert(schema.artifactContributions).values(Array.from({ length: 10 }, () => ({
      id: randomUUID(), artifactId, agentId: "builder" as const, visitorId, requestId: randomUUID(), contributorName: "Test",
      text: "earlier", createdAt: new Date(Date.now() - 2 * 86_400_000),
    })));
    expect((await post(suggestion())).status).toBe(429);
  });

  it("keeps daily and artifact-wide limits even when earlier work is closed", async () => {
    await db.insert(schema.artifactContributions).values(Array.from({ length: 20 }, () => ({
      id: randomUUID(), artifactId, agentId: "builder" as const, visitorId, requestId: randomUUID(), contributorName: "Test",
      text: "earlier", status: "declined" as const, createdAt: new Date(Date.now() - 120_000),
    })));
    expect((await post(suggestion())).status).toBe(429);
    const other = randomUUID();
    await db.insert(schema.visitors).values({ id: other, name: "Other", visitorToken: "other" });
    await db.insert(schema.artifactContributions).values(Array.from({ length: 100 }, () => ({
      id: randomUUID(), artifactId, agentId: "builder" as const, visitorId: other, requestId: randomUUID(), contributorName: "Test",
      text: "queued", createdAt: new Date(Date.now() - 2 * 86_400_000),
    })));
    const fresh = randomUUID();
    await db.insert(schema.visitors).values({ id: fresh, name: "Fresh", visitorToken: "fresh" });
    expect((await post({ ...suggestion(), visitorId: fresh }, "fresh")).status).toBe(429);
  });

  it("journals the actual response tool so same-turn retries preserve one response", async () => {
    const { contribution } = await engine.createContribution(artifactId, suggestion());
    const { buildTools } = await import("../runtime/tools.js");
    const { journalMutatingTools } = await import("../runtime/action-journal.js");
    const tool = journalMutatingTools(buildTools({ agentId: "builder", location: "workshop" }), {
      turnId: randomUUID(), agentId: "builder",
    }).find((t) => t.name === "respond_to_contribution");
    if (!tool || tool.kind !== "function") throw new Error("response tool missing");
    const input = { contributionId: contribution.id, status: "blocked", response: "Need a clearer rule for reset." };
    expect(await tool.run(input)).toContain("blocked");
    expect(await tool.run(input)).toContain("blocked");
    const trail = await engine.artifactTrail(artifactId);
    expect(trail.contributions[0].responses).toHaveLength(1);
    const actionsBefore = await db.select().from(schema.worldEvents).where(eq(schema.worldEvents.type, "agent.acted"));
    const retried = journalMutatingTools(buildTools({ agentId: "builder", location: "workshop" }), {
      turnId: randomUUID(), agentId: "builder",
    }).find((t) => t.name === "respond_to_contribution");
    if (!retried || retried.kind !== "function") throw new Error("response tool missing");
    expect(await retried.run(input)).toContain("already recorded");
    const actionsAfter = await db.select().from(schema.worldEvents).where(eq(schema.worldEvents.type, "agent.acted"));
    expect(actionsAfter.length).toBe(actionsBefore.length);
  });

  it("does not credit a revision while a concurrent response closes the suggestion", async () => {
    const { contribution } = await engine.createContribution(artifactId, suggestion());
    const client = await pool.connect();
    let edit: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM artifact_contributions WHERE id = $1 FOR UPDATE", [contribution.id]);
      edit = updateArtifact(artifactId, { body: "must not commit" }, { agentId: "builder", contributionId: contribution.id })
        .then(() => null, (error: Error) => error);
      // Observe actual PostgreSQL lock contention, not a race against a sleep.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%artifact_contributions%'");
        waiting = result.rowCount! > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await client.query("UPDATE artifact_contributions SET status='declined' WHERE id = $1", [contribution.id]);
      await client.query("COMMIT");
      expect(await edit).toMatchObject({ message: "That contribution is closed." });
      expect((await engine.artifactTrail(artifactId)).revisions).toHaveLength(0);
    } finally { await client.query("ROLLBACK"); client.release(); await edit; }
  });

  it("preserves original and new versions with explicit provenance and durable responses", async () => {
    const { contribution } = await engine.createContribution(artifactId, suggestion());
    await expect(engine.respondToContribution("writer", { contributionId: contribution.id, status: "accepted", response: "yes" })).rejects.toThrow("Only the creation's owner");
    await engine.respondToContribution("builder", { contributionId: contribution.id, status: "accepted", response: "I will add a reset button." });
    await updateArtifact(artifactId, { body: "v2 with reset" }, { agentId: "builder", contributionId: contribution.id });
    let trail = await engine.artifactTrail(artifactId, visitorId);
    expect(trail.revisions.map((r) => r.version)).toEqual([2, 1]);
    expect(trail.revisions[1].contributionId).toBeNull();
    expect(trail.revisions[0].contributionId).toBe(contribution.id);
    const revision = await engine.getArtifactRevision(artifactId, trail.revisions[0].id);
    expect(revision?.body).toBe("v2 with reset");
    expect((await engine.getArtifactRevision(artifactId, trail.revisions[1].id))?.body).toBe("v1");
    const completion = { contributionId: contribution.id, status: "completed", response: "Added a reset button.", revisionId: revision!.id };
    await engine.respondToContribution("builder", completion);
    await engine.respondToContribution("builder", completion);
    trail = await engine.artifactTrail(artifactId, visitorId);
    expect(trail.yours[0].responses.map((r) => r.status)).toEqual(["accepted", "completed"]);
    expect(trail.yours[0]).toMatchObject({ status: "completed", mine: true });
    expect((await engine.pendingContributionsForAgent("builder")).some((r) => r.id === contribution.id)).toBe(false);
  });

  it("rejects forged attribution, unchanged credits, and unrelated result links without editing", async () => {
    const otherId = randomUUID();
    await db.insert(schema.artifacts).values({ id: otherId, agentId: "writer", kind: "project_log", title: "Other", body: "other" });
    const { contribution } = await engine.createContribution(otherId, suggestion());
    await expect(updateArtifact(artifactId, { body: "wrong" }, { agentId: "builder", contributionId: contribution.id })).rejects.toThrow("does not belong");
    await expect(updateArtifact(artifactId, { body: "wrong" }, { agentId: "writer" })).rejects.toThrow("Only the owner");
    const own = await engine.createContribution(artifactId, suggestion());
    await expect(updateArtifact(artifactId, { body: "v1" }, { agentId: "builder", contributionId: own.contribution.id })).rejects.toThrow("No content changed");
    await updateArtifact(artifactId, { body: "unrelated v2" });
    const trail = await engine.artifactTrail(artifactId);
    expect(trail.revisions[0].contributionId).toBeNull();
    await expect(engine.respondToContribution("builder", { contributionId: own.contribution.id, status: "completed", response: "Done", revisionId: trail.revisions[0].id })).rejects.toThrow("explicitly attributed");
    await expect(engine.respondToContribution("builder", { contributionId: own.contribution.id, status: "completed", response: " " })).rejects.toThrow("concrete response");
    await expect(engine.respondToContribution("builder", { contributionId: own.contribution.id, status: "completed", response: "Done" })).rejects.toThrow("saved revision");
  });

  it("rolls versions and artifact content back when the event cannot commit", async () => {
    await db.execute(sql.raw("CREATE OR REPLACE FUNCTION living_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'artifact.updated' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$"));
    await db.execute(sql.raw("CREATE TRIGGER living_test_reject_event BEFORE INSERT ON world_events FOR EACH ROW EXECUTE FUNCTION living_test_reject_event()"));
    try {
      // Drizzle preserves PostgreSQL's trigger error as the query error cause.
      await expect(updateArtifact(artifactId, { body: "not committed" })).rejects
        .toMatchObject({ cause: expect.objectContaining({ message: "test rollback" }) });
    }
    finally {
      await db.execute(sql.raw("DROP TRIGGER living_test_reject_event ON world_events"));
      await db.execute(sql.raw("DROP FUNCTION living_test_reject_event()"));
    }
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    expect(row).toMatchObject({ version: 1, body: "v1" });
    expect((await engine.artifactTrail(artifactId)).revisions).toHaveLength(0);
  });

  it("serializes concurrent edits without losing the intervening version", async () => {
    await Promise.all([updateArtifact(artifactId, { body: "A" }), updateArtifact(artifactId, { body: "B" })]);
    const { revisions } = await engine.artifactTrail(artifactId);
    expect(revisions.map((r) => r.version)).toEqual([3, 2, 1]);
    const bodies = await Promise.all(revisions.map(async (r) => (await engine.getArtifactRevision(artifactId, r.id))?.body));
    expect(bodies.sort()).toEqual(["A", "B", "v1"]);
  });

  it("retains a returning visitor's older contribution outside the public page", async () => {
    const { contribution } = await engine.createContribution(artifactId, suggestion("My old idea"));
    const otherVisitor = randomUUID();
    await db.insert(schema.visitors).values({ id: otherVisitor, name: "Other", visitorToken: "other" });
    await db.insert(schema.artifactContributions).values(Array.from({ length: 21 }, () => ({
      id: randomUUID(), artifactId, agentId: "builder" as const, visitorId: otherVisitor,
      requestId: randomUUID(), contributorName: "Other", text: "new", createdAt: new Date(Date.now() + 1000),
    })));
    const trail = await engine.artifactTrail(artifactId, visitorId);
    expect(trail.contributions.some((r) => r.id === contribution.id)).toBe(false);
    expect(trail.yours.map((r) => r.id)).toContain(contribution.id);
    const pending = await engine.pendingContributionsForAgent("builder");
    expect(pending.length).toBeLessThanOrEqual(10);
  });
});
