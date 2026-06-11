import { defineConfig } from "drizzle-kit";

// drizzle-kit reads this to generate SQL migrations from src/db/schema.ts.
// Migrations are checked in under ./drizzle and applied by src/db/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://town:town@localhost:5433/town",
  },
});
