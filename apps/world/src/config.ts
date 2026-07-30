// Single source of typed environment config for the world server (brief).
// Reads process.env once, derives a `features` object from key presence so
// every integration can degrade gracefully (brief "env-gating pattern").

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const anthropicKey = env("ANTHROPIC_API_KEY");
const openaiKey = env("OPENAI_API_KEY");
const hindsightUrl = env("HINDSIGHT_URL");
const langfuseSecret = env("LANGFUSE_SECRET_KEY");
const langfusePublic = env("LANGFUSE_PUBLIC_KEY");
const resendKey = env("RESEND_API_KEY");
const resendInboundToken = env("RESEND_INBOUND_TOKEN");
const vaultDir = env("VAULT_DIR");
const githubToken = env("GITHUB_TOKEN");

export const config = {
  nodeEnv: env("NODE_ENV") ?? "development",
  port: Number(env("PORT") ?? "8787"),
  // Bind `::` so Railway private networking (IPv6) reaches us; works for IPv4 too.
  host: env("HOST") ?? "::",
  databaseUrl:
    env("DATABASE_URL") ?? "postgresql://town:town@localhost:5433/town",
  dailyBudgetUsd: Number(env("DAILY_BUDGET_USD") ?? "15"),
  adminToken: env("ADMIN_TOKEN"),
  // Comma-separated CORS allowlist (design doc §7). Absent → the HTTP layer
  // applies its localhost dev default. Set to the Vercel prod + preview origins
  // (and any localhost) in production. See apps/world/README.md.
  corsOrigins: env("CORS_ORIGINS"),

  // Retention windows for the two tables nothing else ever prunes (housekeeping,
  // 2026-07-30 — engine/retention.ts, swept daily by runtime/scheduler.ts). Row
  // counts at the time this was added: llm_usage 7,207 rows, thread_summaries
  // 118 rows, both growing without bound. `world_events` and `artifact_state`
  // are deliberately NOT configurable here — see retention.ts's header for why
  // each is left alone (world_events is irreplaceable town history;
  // artifact_state is live app state bounded by per-key caps, not by time).
  retention: {
    // llm_usage is the spend ledger read before every tick and chat turn
    // (spendTodayUsd/spendTodayForAgent) — rows older than this are rolled up
    // into a daily (day×agent×model) summary and then deleted. 30 days is
    // generous for the "did last week's spend look right" question while
    // keeping the hot-path table small; today's rows are never at risk
    // regardless of this value (see llmUsageCutoff).
    llmUsageDays: Number(env("LLM_USAGE_RETENTION_DAYS") ?? "30"),
    // thread_summaries is a lazily-regenerated Haiku cache keyed by calendar
    // day (chronicle.ts) — a cache miss just recomputes it on the next
    // Chronicle read, so this window can be generous without cost: 45 days
    // comfortably covers any day a portfolio visitor would realistically page
    // back to.
    threadSummaryDays: Number(env("THREAD_SUMMARY_RETENTION_DAYS") ?? "45"),
  },

  anthropicApiKey: anthropicKey,
  openaiApiKey: openaiKey,
  hindsightUrl,
  langfuse: {
    secretKey: langfuseSecret,
    publicKey: langfusePublic,
    baseUrl: env("LANGFUSE_BASE_URL"),
  },
  resendApiKey: resendKey,
  resendInboundToken,
  resendAgentDomain: env("RESEND_AGENT_DOMAIN"),
  vaultDir,

  // Read-only GitHub access (fine-grained PAT on Thomas's account). The agents'
  // code-repo reference tools (github.ts) gate on this; absent → they degrade
  // in-fiction. GITHUB_USER scopes listing/search to his account.
  githubToken,
  githubUser: env("GITHUB_USER") ?? "thomasjmiller12",

  // Feature flags derived from key presence — the runtime/tools phase gates on
  // these and logs a one-line summary at boot. Hindsight needs both its URL
  // and an OpenAI key (external embeddings) to actually function.
  features: {
    hindsight: Boolean(hindsightUrl && openaiKey),
    langfuse: Boolean(langfuseSecret && langfusePublic),
    resend: Boolean(resendKey),
    vault: Boolean(vaultDir),
    github: Boolean(githubToken),
  },
} as const;

export type Config = typeof config;

// One-line feature summary for the boot log (brief: "logged at boot in one
// summary block").
export function featureSummary(): string {
  const f = config.features;
  const on = (b: boolean) => (b ? "on" : "off");
  return `features: { hindsight: ${on(f.hindsight)}, langfuse: ${on(
    f.langfuse,
  )}, resend: ${on(f.resend)}, vault: ${on(f.vault)}, github: ${on(f.github)} }`;
}
