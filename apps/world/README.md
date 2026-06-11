# `@town/world` — the world server

The embodiment layer of [Thomas's Town](../../CLAUDE.md) and the source of truth for the
world: locations, agents, an append-only `world_events` log, artifacts, messages, and the
agent runtime (five tick loops on the Anthropic SDK's tool runner). One Node process =
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

# 5. Run the server. Without ANTHROPIC_API_KEY it serves all read endpoints but
#    the scheduler stays off (no ticks). With the key, agents start living.
ANTHROPIC_API_KEY=sk-... pnpm --filter world dev      # tsx watch (dev)
#  or, for the built artifact:
pnpm --filter world build && ANTHROPIC_API_KEY=sk-... pnpm --filter world start
```

Copy `.env.example` → `.env` (gitignored) and fill in keys, or export them inline as above.
The boot log prints a one-line feature summary so you can see what's wired:

```
[boot] world server starting (development) on [::]:8787
[boot] features: { hindsight: off, langfuse: off, resend: off, vault: off }
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
| `GET` | `/health` | liveness `{ ok, ts }` |
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

Every integration is **env-gated**: the server boots and ticks regardless. Missing
integrations degrade *in-fiction* (the agent gets a soft "your memory is hazy today" style
result, never a crash) and the degradation is logged once at boot. The `features` object in
`config.ts` derives each flag from key presence.

| Var | Required? | Default | What it turns on / does when absent |
|---|---|---|---|
| `DATABASE_URL` | yes (dev default works) | `postgresql://town:town@localhost:5433/town` | Postgres + pgvector connection. |
| `ANTHROPIC_API_KEY` | **to tick** | — | The agent runtime. **Absent → scheduler does not start; ticks/chats skipped** (`reason: "no-llm"`). Read endpoints still serve. |
| `NODE_ENV` | no | `development` | In `production`, `/admin/tick` is blocked unless `ADMIN_TOKEN` is set. |
| `PORT` | no | `8787` | HTTP listen port. |
| `HOST` | no | `::` | Bind host (`::` for Railway IPv6 private networking). |
| `DAILY_BUDGET_USD` | no | `15` | Global hard spend ceiling/day across all agents. Per-agent soft caps are in `roles/*.yaml`. Cap trip → status `"sleeping (budget)"`, scheduler skips until UTC midnight. |
| `ADMIN_TOKEN` | no | — | When set, `/admin/tick` requires header `x-admin-token`. |
| `HINDSIGHT_URL` | no | — | **feature: hindsight** (needs `OPENAI_API_KEY` too). Episodic memory store. Absent → `remember`/`recall`/`forget` return an in-fiction "memory is hazy" soft failure. Core memory (the `memory` tool) is unaffected. |
| `OPENAI_API_KEY` | no | — | External embeddings for Hindsight (the only thing it's used for). Half of the `hindsight` flag. |
| `LANGFUSE_SECRET_KEY` + `LANGFUSE_PUBLIC_KEY` | no | — | **feature: langfuse**. Tracing. Absent → tracing is a no-op wrapper; everything else identical. (`LANGFUSE_BASE_URL` optional.) |
| `RESEND_API_KEY` | no | — | **feature: resend**. Outbound email (`email_thomas`). Absent → email is queued to an outbox row and reported queued-not-sent in-fiction. |
| `VAULT_DIR` | no | — | **feature: vault**. Absolute path to the synced Obsidian clone. Absent → reference tools degrade in-fiction; `write_agent_note` writes to a local `vault-pending/` dir so nothing is lost. Sync also uses `VAULT_REPO_URL` + `VAULT_DEPLOY_KEY_PATH`. |

### Keys not yet provisioned (arrive at deploy)

As of Milestone 1 only `ANTHROPIC_API_KEY` is available locally. The rest are env-gated and
"light up" their feature when their key lands:

- **OpenAI** (embeddings) + **Hindsight** container → real episodic memory (verbatim mode).
- **Langfuse** cloud keys → the full `@langfuse/otel` exporter (currently a structured-log
  fallback when keys are present; wire the OTel exporter at deploy — see plan §2 row 10).
- **Resend** key → real outbound mail (outbound-only MVP via `onboarding@resend.dev`).
- **Vault** repo + deploy key → the obsidian-git → GitHub → server-pull reference layer.

When wiring real Hindsight, confirm the exact env-var names / endpoint shapes against the
pinned `0.7.0-slim` image (they were taken from the plan, not runtime-verified locally).

## Local infra (`docker-compose.yml`, repo root)

- **postgres** — `pgvector/pgvector:pg17`, host port `5433`, db/user/pass = `town`.
- **hindsight** — `ghcr.io/vectorize-io/hindsight:0.7.0-slim`, API `:8888` / UI `:9999`,
  pointed at the same Postgres. Stays degraded without `OPENAI_API_KEY` — expected for M1.

`docker compose up -d postgres` starts just Postgres (enough to run + tick the world).
