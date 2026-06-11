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
const vaultDir = env("VAULT_DIR");

export const config = {
  nodeEnv: env("NODE_ENV") ?? "development",
  port: Number(env("PORT") ?? "8787"),
  // Bind `::` so Railway private networking (IPv6) reaches us; works for IPv4 too.
  host: env("HOST") ?? "::",
  databaseUrl:
    env("DATABASE_URL") ?? "postgresql://town:town@localhost:5433/town",
  dailyBudgetUsd: Number(env("DAILY_BUDGET_USD") ?? "15"),
  adminToken: env("ADMIN_TOKEN"),

  anthropicApiKey: anthropicKey,
  openaiApiKey: openaiKey,
  hindsightUrl,
  langfuse: {
    secretKey: langfuseSecret,
    publicKey: langfusePublic,
    baseUrl: env("LANGFUSE_BASE_URL"),
  },
  resendApiKey: resendKey,
  vaultDir,

  // Feature flags derived from key presence — the runtime/tools phase gates on
  // these and logs a one-line summary at boot. Hindsight needs both its URL
  // and an OpenAI key (external embeddings) to actually function.
  features: {
    hindsight: Boolean(hindsightUrl && openaiKey),
    langfuse: Boolean(langfuseSecret && langfusePublic),
    resend: Boolean(resendKey),
    vault: Boolean(vaultDir),
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
  )}, resend: ${on(f.resend)}, vault: ${on(f.vault)} }`;
}
