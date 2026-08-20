# `@town/world` — the world server

The embodiment layer of [Thomas's Town](../../CLAUDE.md) and the source of truth for the
world: locations, agents, an append-only `world_events` log, artifacts, messages, and the
agent runtime (five continuous tick loops behind an Anthropic/OpenAI provider interface).
One Node process =
**migrations check + scheduler + Hono API + SSE**. Surfaces (the Phaser frontend, the
activity feed) hold zero authoritative state; they materialize this server's event log.

See the build plan (in Thomas's vault — path in the repo `CLAUDE.md`) for the full
architecture; the orchestrator brief lives at `scratch/m1-brief.md`.

## Run it locally

Prereqs: Node ≥ 22, pnpm 11, Docker (for Postgres + pgvector). Run all commands from the
repo root.

```bash
# 1. Install (workspace-aware — needs the repo root for pnpm context)
pnpm install

# 2. Start Postgres (pgvector/pgvector:pg17, host port 5433, db/user/pass = town)
docker compose up -d postgres

# 3. Apply the checked-in Drizzle migrations + ensure the pgvector extension
pnpm --filter world migrate

# 4. Seed 6 locations + 5 agents (idempotent — safe to re-run)
pnpm --filter world seed

# 5. Put keys in the gitignored apps/world/.env, select a provider, and run.
#    The selected provider's missing key leaves read endpoints up but scheduler off.
cd apps/world
LLM_PROVIDER=anthropic node --env-file=.env --import tsx src/index.ts
# or:
LLM_PROVIDER=openai node --env-file=.env --import tsx src/index.ts
# built artifact:
pnpm build && LLM_PROVIDER=openai node --env-file=.env dist/index.js
```

Copy `.env.example` → `.env` (gitignored) and fill in keys. The commands above override
only the non-secret provider selector; they do not put API keys in shell history or tracked
files. `pnpm --filter world dev` still works when the variables are already exported.
The boot log prints a one-line feature summary so you can see what's wired:

```
[boot] world server starting (development) on [::]:8787
[boot] llm: { provider: openai, configured: on }; features: { hindsight: on, langfuse: off, resend: off, vault: off, github: off }
[boot] listening on [::]:8787
[scheduler] starting: 5 agents, dynamic rate (visitor boost 0.33x, overnight 2x).
```

### Boot sequence & shutdown

1. **Migrations check** — probes the `agents` table; if the schema is missing or the DB is
   unreachable, the server exits non-zero with the migrate/seed command to run. It never
   auto-migrates at boot (migrate is an explicit step) so a bad deploy can't silently mutate
   the DB.
2. **Boot summary** — logs the feature flags before the scheduler ticks.
3. **Serve + scheduler** — Hono API + SSE come up, then the in-process scheduler starts
   (staggered per-agent timers, dynamic rate, nightly reflection, vault sync).
4. **Graceful shutdown** — `SIGTERM`/`SIGINT` stop the scheduler, stop accepting
   connections, drain the DB pool, and exit (10s hard cap).

## Test, build, typecheck

```bash
pnpm --filter world test        # vitest (engine + runtime unit tests)
pnpm --filter world build       # tsc → dist/
pnpm --filter world typecheck   # tsc --noEmit
```

## Force a tick (smoke test)

`POST /admin/tick/:agentId` runs one tick synchronously and returns
`{ ran, reason, rounds, costUsd, cacheReadTokens }`. Guarded by `ADMIN_TOKEN` when set;
allowed off-production otherwise. The 2nd+ tick of the same agent should report
`cacheReadTokens > 0` (the byte-stable `[soul + facet + protocol]` prefix is cached for 1h).

```bash
curl -X POST http://localhost:8787/admin/tick/builder
curl -s http://localhost:8787/feed | jq '.items[].line'      # day-in-the-life lines
curl -s http://localhost:8787/world/snapshot | jq            # agents/conversations/events
curl -N http://localhost:8787/events/stream                  # live SSE
open http://localhost:8787/debug                             # server-rendered status page
```

## HTTP surface (contract §5)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | process liveness plus provider/configured/model and agent-health metadata (always HTTP 200 while serving) |
| `GET` | `/world/snapshot` | agents (location/status/activity), active conversations, recent events |
| `GET` | `/events/stream` | SSE; `Last-Event-ID`/`?lastEventId=` resume; `?visitorId=` ties presence to the connection; 25s heartbeats |
| `GET` | `/events?after=<id>` | catch-up / polling fallback |
| `GET` | `/feed?agent=&cursor=` | paginated human-readable activity look-back |
| `GET` | `/agents/:id` | profile, recent artifacts, last ~5 events |
| `GET` | `/messages?scope=broadcast\|dm&cursor=` | visitor-readable social log |
| `GET` | `/artifacts?kind=&agent=` · `/artifacts/:id` | blog posts, bulletins, project logs |
| `POST` | `/visitors {name}` | register presence → `visitorId` |
| `POST` | `/chats {agentId, visitorId}` | open a chat session (agent goes busy) |
| `POST` | `/chats/:id/messages {text}` | SSE stream of response tokens |
| `POST` | `/chats/:id/close` | end the session |
| `POST` | `/admin/tick/:agentId` | force one tick (smoke tests) |
| `GET` | `/debug` | dead-simple server-rendered status page |

## Configuration

Per-agent tick cadence, model, and budget live in `roles/<agent>.yaml` (config, not code).
Soul files are `souls/base.md` (shared Thomas layer) + `souls/<agent>.md` (per facet).

### Environment variables

Every integration is **env-gated**: the server always boots. The scheduler and model-backed
endpoints require the key for the selected `LLM_PROVIDER`; other missing integrations degrade
*in-fiction* and are logged once at boot. The unselected provider's key is optional. The
`features` object in `config.ts` derives non-runtime integration flags from key presence.

| Var | Required? | Default | What it turns on / does when absent |
|---|---|---|---|
| `DATABASE_URL` | yes (dev default works) | `postgresql://town:town@localhost:5433/town` | Postgres + pgvector connection. |
| `LLM_PROVIDER` | no | `anthropic` | Boot-time world-model provider: `anthropic` or `openai`. There is no per-turn fallback. |
| `ANTHROPIC_API_KEY` | when `LLM_PROVIDER=anthropic` | — | Anthropic turns and stateless generation. Its absence is irrelevant when OpenAI is selected. |
| `OPENAI_API_KEY` | when `LLM_PROVIDER=openai`; also for Hindsight | — | OpenAI turns/stateless generation when selected. Independently required by Hindsight's embeddings and extraction LLM even when Anthropic is selected. |
| `NODE_ENV` | no | `development` | In `production`, `/admin/tick` is blocked unless `ADMIN_TOKEN` is set. |
| `PORT` | no | `8787` | HTTP listen port. |
| `HOST` | no | `::` | Bind host (`::` for Railway IPv6 private networking). |
| `DAILY_BUDGET_USD` | no | `15` | Global hard spend ceiling/day across all agents. Per-agent soft caps are in `roles/*.yaml`. Cap trip → status `"sleeping (budget)"`, scheduler skips until UTC midnight. |
| `ADMIN_TOKEN` | no | — | When set, `/admin/tick` requires header `x-admin-token`. |
| `CORS_ORIGINS` | **in prod** | — | Comma-separated CORS allowlist (design §7). Unset → a localhost dev default (`http://localhost:3000`, `:8787` + the `127.0.0.1` forms). In production set it to the exact Vercel origin(s) the frontend is served from so the browser can read cross-origin — e.g. `https://<project>.vercel.app` (matching is exact-origin, not a glob; list each preview URL you want allowed). Trailing slashes are ignored; an unlisted origin simply gets no CORS headers (request blocked client-side). |
| `HINDSIGHT_URL` | no | — | **feature: hindsight** (needs `OPENAI_API_KEY` too). Episodic memory store. Absent → `remember`/`recall`/`forget` return an in-fiction "memory is hazy" soft failure. Core memory (the `memory` tool) is unaffected. |
| `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` | no | — | **feature: langfuse**. Real OTel tracing via `@langfuse/otel` (trace = tick, `userId` = agent, `sessionId` = day, `soulGitHash` in metadata). Absent → tracing is a strict no-op; everything else identical. `LANGFUSE_BASE_URL` selects the region (default `https://us.cloud.langfuse.com`). |
| `RESEND_API_KEY` | no | — | **feature: resend**. Outbound email (`email_thomas`). Absent → email is queued to an outbox row and reported queued-not-sent in-fiction. |
| `RESEND_AGENT_DOMAIN` | no | — | When set, agent emails send from facet-specific addresses such as `builder@town.latent-garden.com`; replies route back through Resend Receiving. Absent → legacy `onboarding@resend.dev`. |
| `RESEND_INBOUND_TOKEN` | no | — | Shared secret for `POST /webhooks/resend/inbound`. Put it in the Resend webhook URL as `?token=...` or send it as `x-webhook-token`. |
| `VAULT_DIR` | no | — | **feature: vault**. Absolute path to the synced Obsidian clone. Absent → reference tools degrade in-fiction; `write_agent_note` writes to a local `vault-pending/` dir so nothing is lost. Sync also uses `VAULT_REPO_URL` + `VAULT_DEPLOY_KEY_PATH`. |
| `GITHUB_TOKEN` | no | — | **feature: github**. A **fine-grained, read-only** PAT on Thomas's GitHub account (permissions: Contents → Read-only, Metadata → Read-only; repository access: all repos or a chosen set). Turns on the code-repo reference tools (`list_repos`, `browse_repo`, `read_repo_file`, `search_code`) — read-only, never gated to a place. Absent → those tools degrade in-fiction. `GITHUB_USER` (default `thomasjmiller12`) scopes listing/search to the account. |

### Provider selection and continuity

`LLM_PROVIDER` is read once at boot and selects every world-model workload: autonomous
ticks, visitor turns, reflections, dataset delivery, Chronicle summaries, and Town Crier
issues. The current role maps are:

| Workload | Anthropic | OpenAI |
|---|---|---|
| Per-agent tick/chat (`roles/*.yaml`) | `claude-sonnet-5` | `gpt-5.4` |
| Chronicle | `claude-haiku-4-5` | `gpt-5.4` |
| Town Crier | `claude-sonnet-5` | `gpt-5.4` |

Each adapter owns its SDK loop, strict tool wrappers, compaction, history validation, and
usage normalization. Shared orchestration treats native history as opaque `unknown[]`.
Never convert, merge, or copy history items between providers. Portable identity—soul,
core memory, Hindsight, diary, artifacts, social history, and world state—is shared; each
provider keeps a separate `(agent_id, provider)` living thread. The first turn on a provider
without a row seeds from portable continuity. Switching back resumes that provider's prior
native thread.

Uploads are provider-owned too. `POST /admin/deliver` accepts an attachment shaped like
`{ "provider": "openai", "fileId": "...", "filename": "data.csv" }`. A provider mismatch
returns 409; upload the file through the selected provider and retry. Never persist temporary
container handles in portable state.

Run the opt-in OpenAI adapter smoke test (real API traffic, harmless test-only in-memory
thread) from `apps/world`:

```bash
OPENAI_LIVE_TEST=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
  src/runtime/llm/openai/provider.live.test.ts
```

The equivalent Anthropic smoke uses the same harmless tool→resume shape:

```bash
ANTHROPIC_LIVE_TEST=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
  src/runtime/llm/anthropic/provider.live.test.ts
```

For an end-to-end Anthropic or OpenAI smoke test, start a disposable database/server with
the desired `LLM_PROVIDER`, then call `POST /admin/tick/builder`. Do not use the production
agent database for provider evaluation.

### Database rollout, switch, and rollback

Provider persistence uses an expand/contract rollout because Railway can overlap old and new
processes during deploys. Migration `0017_quiet_flatman.sql` is the additive Release A: it
backfills `provider='anthropic'`, adds `endpoint`, and adds composite unique indexes while
retaining legacy primary keys. **Do not enable OpenAI in a database that has only Release A.**
The old `agent_threads(agent_id)` primary key still prevents Anthropic and OpenAI rows for the
same agent. Migration `0018_llm_provider_keys.sql` is Release B: after Release A is live and
the old process has drained, it promotes the existing composite indexes to primary keys without
rebuilding them.

Both releases are live in production as of 2026-08-19. The Railway `world` service is currently
configured with `LLM_PROVIDER=openai` and `OPENAI_AGENT_MODEL=gpt-5.4`; production health and a
two-turn Builder thread-resume smoke test passed. The five preserved Anthropic thread rows remain
untouched for rollback.

Release A verification:

```sql
SELECT provider, count(*) AS threads FROM agent_threads GROUP BY provider;
SELECT provider, endpoint, count(*) AS calls FROM llm_usage GROUP BY provider, endpoint;
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('agent_threads', 'llm_usage_daily')
ORDER BY tablename, indexname;
```

Before Release B, confirm all provider columns are populated and composite keys have no
duplicates:

```sql
SELECT count(*) FROM agent_threads WHERE provider IS NULL;
SELECT agent_id, provider, count(*)
FROM agent_threads GROUP BY agent_id, provider HAVING count(*) > 1;
SELECT day, agent_id, provider, model, count(*)
FROM llm_usage_daily
GROUP BY day, agent_id, provider, model HAVING count(*) > 1;
```

After Release B promotes the composite primary keys, switch with one variable:

1. Snapshot Anthropic continuity: `SELECT agent_id, md5(content::text), updated_at FROM agent_threads WHERE provider='anthropic' ORDER BY agent_id;`.
2. Confirm `/health` reports `provider: "openai"`, `providerConfigured: true`, and the expected `gpt-5.4` model map in a staging/disposable environment.
3. Set `LLM_PROVIDER=openai`, redeploy, force one Builder tick, inspect its trace/usage/thread, then allow the scheduler to proceed.
4. Watch provider/model/endpoint spend, failures, compaction, thread size, latency, and visitor-visible transcript parity.

Rollback is the inverse: set `LLM_PROVIDER=anthropic`, redeploy, force one tick, and verify
the prior Anthropic row advances from its saved history. Do not delete/reseed OpenAI rows.
Automatic cross-provider fallback is intentionally absent because it would make continuity,
spend, and incident diagnosis ambiguous.

Expected provider fields in `/health` (other health fields omitted):

```json
{
  "llm": true,
  "provider": "openai",
  "providerConfigured": true,
  "models": {
    "agents": [{ "agent": "builder", "tick": "gpt-5.4", "chat": "gpt-5.4" }],
    "chronicle": "gpt-5.4",
    "townCrier": "gpt-5.4"
  }
}
```

### Integrations (verified live)

Every integration is env-gated — the server boots and ticks with any subset absent. As of
Milestone 1 these three are wired and proven end-to-end against the real services:

- **OpenAI provider adapter** → `gpt-5.4` Responses/Agents SDK turns with strict town
  tools, Code Interpreter, provider-native compaction/history, cached-input accounting,
  and an opt-in live tool→resume smoke test.
- **OpenAI** + **Hindsight** container → real episodic memory (verbatim mode). The
  `remember`/`recall`/`reflect` tools hit the Hindsight REST API live; recall is
  semantically relevant. See "Hindsight API shape" below for the endpoints we use.
- **Langfuse** cloud keys → the real `@langfuse/otel` v5 exporter (manual spans — we own the
  toolRunner loop, so no auto-instrumentation). Each tick is a trace (`userId` = agent,
  `sessionId` = UTC day, metadata `soulGitHash` = git blob hash of the agent's soul file).
  Flushed on shutdown and force-flushed after `/admin/tick` for fast verification.
- **Resend** key → real outbound mail (outbound-only MVP via `onboarding@resend.dev`).
  `email_thomas` → `sendEmailToThomas` returns Resend's provider `messageId` on success.
  `RESEND_TO` / `RESEND_FROM` override the recipient / sender for testing.
- **Resend Receiving** → inbound replies. `email.received` webhooks hit
  `/webhooks/resend/inbound`; the recipient local part routes to a facet
  (`builder@town.latent-garden.com`, `career@...`). Ticks show unread outside
  mail headers, and agents open the body with `read_mail`.
- **Vault** repo + deploy key → the obsidian-git → GitHub → server-pull reference layer
  (still env-gated, not wired in M1).

#### Hindsight API shape (pinned `0.7.0-slim`, runtime-verified)

Bank-per-agent (`town-<agentId>`). Endpoints `src/runtime/hindsight.ts` uses:
- retain: `POST /v1/default/banks/{bank}/memories` — `{ items: [{ content, tags, metadata }], async: false }`
- recall: `POST /v1/default/banks/{bank}/memories/recall` — `{ query, max_tokens }` → `{ results: [{ id, text }] }`
- reflect: `POST /v1/default/banks/{bank}/reflect` — `{ query }` → `{ text }`
- delete: `DELETE /v1/default/banks/{bank}/memories[?type=]` — bank/type-wide only.
  Hindsight has **no per-memory delete**, so the model-facing `forget` tool is a soft
  acknowledgement (the memory fades); destructive clears are an operator-only path.

## Local infra (`docker-compose.yml`, repo root)

- **postgres** — `pgvector/pgvector:pg17`, host port `5433`, db/user/pass = `town`.
- **hindsight** — `ghcr.io/vectorize-io/hindsight:0.7.0-slim`, API `:8888` / UI `:9999`,
  pointed at the same Postgres under its own `hindsight` schema. Needs `OPENAI_API_KEY`
  (passed through compose) for both embeddings and the extraction LLM. Two gotchas the
  compose handles: (1) the `-slim` image has no `sentence-transformers`, so the default
  `local` cross-encoder reranker crash-loops — we set `HINDSIGHT_API_RERANKER_PROVIDER=rrf`;
  (2) Hindsight's keyword search uses pg_trgm's `%` operator, which must live in `public`
  (where `vector` is) — `pnpm --filter world migrate` creates `pg_trgm WITH SCHEMA public`.

`docker compose up -d postgres` starts just Postgres (enough to run + tick the world).
`docker compose up -d` (with `OPENAI_API_KEY` exported) also starts Hindsight.
