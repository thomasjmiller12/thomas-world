// apps/world — the world server (embodiment layer): one Node process =
// migrations check + scheduler + Hono API + SSE. Binds `::` for Railway private
// networking. Boots and serves regardless of which integrations are configured
// (env-gated; see config.featureSummary()).
//
// Boot sequence:
//   1. Migrations check — confirm the schema is reachable + applied (fail fast
//      with a clear instruction if not; we never auto-migrate at boot so a bad
//      deploy can't silently mutate the DB).
//   2. Boot summary — one block logging the feature flags (hindsight / langfuse
//      / resend / vault on|off) so degraded integrations are obvious at a glance.
//   3. Serve — start the Hono API + SSE.
//   4. Scheduler — start the in-process agent scheduler (staggered idle ticks,
//      dynamic rate, nightly reflection, vault sync). No-op without ANTHROPIC_API_KEY.
//   5. Graceful shutdown — stop the scheduler, stop accepting connections, drain
//      the DB pool, then exit.

import { serve } from "@hono/node-server";
import { eq, sql } from "drizzle-orm";
import { config, featureSummary } from "./config.js";
import { db, pool, schema } from "./db/client.js";
import { createApp } from "./http/app.js";
import { startScheduler, stopScheduler } from "./runtime/scheduler.js";
import { initTracing, shutdownTracing } from "./runtime/tracing.js";

// Confirm the DB is reachable and the schema has been migrated. We probe a core
// table (`agents`) rather than auto-running migrations — applying migrations is
// an explicit `pnpm --filter world migrate` step (and seeding follows it), so a
// boot that finds an unmigrated DB is an operator error we surface loudly.
async function migrationsCheck(): Promise<void> {
  try {
    await db.execute(sql`select 1 from agents limit 1`);
  } catch (err) {
    // Redact any embedded credentials before logging the connection string —
    // Railway logs are visible to all project members.
    const safeUrl = config.databaseUrl.replace(/:\/\/([^:@/]+):[^@/]+@/, "://$1:***@");
    console.error(
      "[boot] migrations check failed — the `agents` table is missing or the DB is unreachable.\n" +
        "       Run:  docker compose up -d postgres && pnpm --filter world migrate && pnpm --filter world seed\n" +
        `       (DATABASE_URL=${safeUrl})`,
    );
    console.error("[boot] underlying error:", (err as Error).message);
    process.exit(1);
  }
}

// No chat session or conversation scene survives a process restart, so any
// `busy=true` left in the DB is stale (a crash mid-scene/mid-chat). Clearing it
// at boot prevents an agent from being permanently skipped by the scheduler
// (runTick returns reason "busy" forever otherwise) with no log line.
async function clearStaleBusy(): Promise<void> {
  const cleared = await db
    .update(schema.agents)
    .set({ busy: false })
    .where(eq(schema.agents.busy, true))
    .returning({ id: schema.agents.id });
  if (cleared.length) {
    console.log(
      `[boot] reset stale busy flag on ${cleared.length} agent(s): ${cleared
        .map((a) => a.id)
        .join(", ")}`,
    );
  }
}

// Warn loudly about misconfigurations that would silently break the soak.
function bootConfigWarnings(): void {
  // /admin/tick is unguarded when neither ADMIN_TOKEN nor NODE_ENV=production is
  // set — it would be publicly callable on a Railway public domain.
  if (!config.adminToken && config.nodeEnv !== "production") {
    console.warn(
      "[boot] /admin/tick is UNGUARDED — set ADMIN_TOKEN or NODE_ENV=production before exposing publicly.",
    );
  }
  // Resend enabled but no real recipient set → agent emails go to the test sink
  // (delivered@resend.dev) and Thomas never sees them.
  if (config.features.resend && !process.env.RESEND_TO) {
    console.warn(
      "[boot] RESEND is on but RESEND_TO is unset — agent emails go to the resend.dev sink, NOT Thomas. Set RESEND_TO to his real address.",
    );
  }
}

async function main(): Promise<void> {
  // A dropped timer reschedule or a stray async error must never silently kill
  // an agent for the rest of a 48h soak — log loudly instead of letting Node
  // swallow (or crash on) it.
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] unhandledRejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[fatal] uncaughtException:", err);
  });

  // Start the tracing exporter first so every traced tick/chat is captured
  // (no-op when Langfuse keys are absent).
  await initTracing();

  await migrationsCheck();
  await clearStaleBusy();

  // Boot summary — log feature flags up front, before the scheduler ticks.
  console.log(`[boot] world server starting (${config.nodeEnv}) on [${config.host}]:${config.port}`);
  console.log(`[boot] ${featureSummary()}`);
  bootConfigWarnings();

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[boot] listening on [${config.host}]:${info.port}`);
    startScheduler();
  });

  // Graceful shutdown: stop ticking, stop accepting connections, drain the pool.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — stopping scheduler and draining.`);
    stopScheduler();
    server.close(async () => {
      await shutdownTracing().catch(() => {});
      await pool.end().catch(() => {});
      console.log("[shutdown] done.");
      process.exit(0);
    });
    // Hard cap: don't hang forever if a connection won't drain.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
