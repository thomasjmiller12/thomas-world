// Applies the checked-in drizzle SQL migrations, then ensures the pgvector and
// pg_trgm extensions exist in `public` (Hindsight shares this database and needs
// both). pg_trgm must live in `public` so its `%` similarity operator is on the
// search path for Hindsight's keyword search — without it retain/recall 500 with
// "operator does not exist: text % text". Cheap and idempotent to do here.
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { db, pool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../../drizzle");

async function main() {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`);
  await migrate(db, { migrationsFolder });
  console.log(`migrations applied from ${migrationsFolder}`);
  await pool.end();
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
