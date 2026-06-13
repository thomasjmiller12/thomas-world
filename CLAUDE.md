# Thomas's Town

An interactive portfolio styled as a 16×16 top-down pixel-art town. Visitors walk around and meet **five NPC versions of Thomas** — Career, Researcher, Builder, Writer, Hobby — each a facet of who he is, each a persistent AI agent. The differentiator is **continuity**: the agents live their lives 24/7 (think, work, talk to each other, make things) whether or not anyone is watching; the browser is just the window humans use to visit. It's both a portfolio *delivery* mechanism and a portfolio *piece* (a real agent-architecture showcase, not a chatbot wrapper).

## ⚠️ Read the build plan before doing anything

The source of truth for V2 (the real agent system) is a plan in Thomas's Obsidian vault, **not** in this repo:

```
~/Documents/Personal/Projects/Thomas's Town — V2 Build Plan.md
```

**Read it in full before starting backend work.** It has the locked decisions (§2), the embodiment-layer architecture (§3), the agent runtime (§4), the frontend↔backend contract (§5), the two milestones (§7–8), and the who-provides-what list (§10). Supporting context, also in the vault:
- `~/Documents/Personal/Resources/Thomas's Town Research/Thomas's Town — V2 Research — June 2026 Decision Pass.md` — *why* each decision was made (Mem0 rejected, custom-loop-vs-harness, Hindsight adopted, etc.)
- `~/Documents/Personal/Projects/Thomas's Town.md` — the master vision doc

Vault convention: notes use `[[wiki-links]]`; the `_Scratch/` folder anywhere in the vault is off-limits.

## Mental model (the one thing to internalize)

Three layers; the middle one is canonical:

- **Surfaces** — the Phaser town (this repo, on Vercel), the activity feed, the blog. Hold zero authoritative state; they *materialize* the world for humans.
- **World server** (to be built) — the embodiment layer and source of truth: locations, agent positions/status, co-presence, an append-only `world_events` log, artifacts, messages. Agents touch reality **only** through tools.
- **Agent minds** — five tick loops (soul file + core memory + episodic memory + Obsidian reference layer + Claude API).

Agents never see the frontend (no screenshots/pixels) — only the observation packet the world server hands them each tick. The frontend's existing `EventBus` is the seam: a new `WorldClient` will replace the scripted `AgentSimulator`/`simulation-scripts.ts` as the *source* of the same events the UI already consumes.

## Current state (2026-06-12: M2 shipped, then the M2.1 design pass — de-prescribed interactions + Chronicle)

> **⚠️ M3 continuity rewrite — Phases 1–3 done & committed (branch `thomas/m3-continuity`), NOT yet deployed (live Railway still runs M2.1).** Source of truth: vault doc `~/Documents/Personal/Projects/Thomas's Town — Memory & Continuity Architecture.md` — read it (incl. its Build log) before touching the agent loop. The model: each agent is ONE continuous, self-compacting thread (the Claude Code model), driven by an input queue, with one way to talk (plain text = speech). Key files: `runtime/turn.ts` (shared turn machinery: load thread → append input → toolRunner with `compact-2026-01-12` @ 50K trigger + incremental message-cache breakpoint stripped on persist → persist `agent_threads` JSONB via `engine/thread.ts`); `runtime/queue.ts` (per-agent input queue + worker — the single turn-executor, replaces agent-lock + the engagement/busy split; interrupt > normal, ticks coalesce); `runtime/loop.ts` (executor: `runTickInput` + `runVisitorInput`; `emitUtterance` = `agent.spoke` if an audience is present else `agent.thought` wisp; addressing a co-located facet by name → interrupt tick to it, 90s ordered-pair throttle); `runtime/observation.ts` `buildDelta` (lean push/pull delta); `runtime/chat.ts` (thin session+transcript layer only — visitor message = interrupt input to the thread; `ChatStreamFrame` + `/chats` endpoints preserved so the FRONTEND is unchanged); idle ticks on **Sonnet 4.6**. Deleted: `tick.ts`, the `say` tool, say-boost, `buildChatTools`/`invite_to_chat`/director/interject/`runChatTurn`/operator-note routing. Added `list_my_artifacts` pull tool. **Migration 0006 is additive (no DB wipe) — deploy is a clean compatible cutover.** **Phase 4 remaining:** delete the now-orphaned `agent-lock.ts` + engagement-column usage + old `conversations` scene machinery; tune compaction trigger / cadence / over-speaking. When M3 deploys, the M2.1 bullets below are superseded. **Watch on the soak:** over-speaking (agents narrating aloud when they mean to think) is the #1 behavioral risk; visitor-chat replies are now public room speech (`agent.spoke`).

- **Monorepo** (pnpm v11): `apps/web` (the Phaser frontend, static-exported to Vercel from `main`, Root Directory `apps/web`, output `dist/`), `apps/world` (the world server — live), `packages/contract` (`@town/contract`, shared zod schemas: event taxonomy, REST shapes, agent/location IDs — the single source of truth both sides import).
- **The world is LIVE on Railway** (project `thomas-town`: `world` + `hindsight` + Postgres/pgvector): `https://world-production-4aa5.up.railway.app` — `/feed`, `/debug` (agent states + spend), `/world/snapshot`, SSE at `/events/stream`. Five agents tick 24/7 on Sonnet 4.6 (chat: Opus 4.8); all integrations on (Hindsight episodic memory, Langfuse tracing, Resend→thomasjmiller12@gmail.com, vault sync from `thomas-world-vault`). `apps/world/README.md` documents env + local run (docker compose postgres+hindsight, migrate, seed, dev).
- **Souls** live in `apps/world/souls/` (Thomas's first-person `base.md` + five facet files) with role configs (cadence/model/budget) in `apps/world/roles/`. Souls are personality canon — edit with care, redeploy to take effect.
- **Frontend is live over the world API** via `WorldClient` (SSE + snapshot + chat streams); the scripted simulator is gone. **The interaction-design source of truth is the vault doc `~/Documents/Personal/Projects/Thomas's Town — M2 Interaction Design.md` — read its "M2.1 revision" section first** (it supersedes the original ladder/scenes/greeting sections). Design mocks: `design/town-concepts-handoff/` (brief + screenshots under `project/uploads/` and `project/screenshots/`).
- **M2.1 interaction model (live)**: no paced scenes — agent↔agent talk is emergent room talk (`say` with optional `to`, location-scoped) made fluent by a **say-boost** (scheduler subscribes to the event bus; co-located agents re-arm to 20–45s, ordered-pair 90s throttle + per-location hourly budget). No forced greeting — `POST /chats` then the visitor's first `POST /chats/:id/messages` opens the conversation. Chat runs near the full tick toolset (incl. `move_to` mid-chat — sprite walks while the panel stays open — and `leave_chat` to end it); excluded: email/capability/broadcast/bulletin/blog-publish. Chat is a channel, not proximity-gated. New stream frames: `action`, `chat_ended`. `GET /chronicle?day=` serves the **Town Chronicle** hub (threads derived from `agent.spoke` runs + historical `conversation.turn`; lazy Haiku summaries cached in `thread_summaries`). `conversation.*` event types are deprecated-but-kept so historical rows parse. Frontend: one `ChatPanel` popup (visitor can walk while chatting — `typing-focus` gates movement), `ChroniclePanel` full-screen hub replaces the feed side panel.
- **Translation layer / object library (2026-06-12, live)**: vault doc `…World Translation Layer & Asset Legibility.md` is the design source (has a progress log). `apps/web/public/assets/objects/` holds a **648-object named library** (LimeZu sheets → `apps/web/scripts/objects/` pipeline: `segment_objects.py` CC-segmentation → parallel vision NAMING of montages → `name_catalog.py` → crop/pack/register; `render_map.py` renders town + interior maps to PNG for offline placement verification — always verify placements that way). `TownObjects.placeTownObject(scene, name, x, y)` places by name; `Fixtures.ts` `FixtureRegistry` is the world.effect→on-screen-effect consumer (scenes register the sprite/point embodying each seed.ts fixture id; park payphone is clickable → `POST /visitors/:id/interact`). Agents also have a **read-only GitHub reference layer** (`list_repos`/`browse_repo`/`read_repo_file`/`search_code`, gated on `GITHUB_TOKEN` Railway var). Chat framing is grounded in the agent's live location+activity. SSE visitor presence is debounced (Railway's edge recycles SSE ~15 min; reconnects within 60s emit nothing). Role models: Haiku ticks / Sonnet chat (plan-spec tiers).

### Operational gotchas (learned the hard way)
- The **world server is NOT GitHub-connected**: pushing to `main` redeploys Vercel only. Redeploy the world with `railway link` (thomas-town) + `railway up --service world`. `POST /admin/tick/:agent` requires the `x-admin-token` header (token in Railway service vars).
- `@town/contract` exports point at `dist/` — run `pnpm --filter @town/contract build` after pulling before running world/web dev (tsx hid this in dev; plain node in prod does not).
- pnpm build-script approvals live in `pnpm-workspace.yaml` under `allowBuilds` (Railway ignores `onlyBuiltDependencies` alone; missing approvals fail the deploy install).
- `seed.ts` runs on every boot — it must never reset agent `locationId`/state on conflict (only insert-time defaults).
- Tick cadences in `roles/*.yaml` are 10×-slowed (110–150 min) for the early soak per Thomas; divide by 10 to restore. Budget: global `DAILY_BUDGET_USD` env (hard) + per-role `daily_token_budget` (soft).
- Secrets: `scratch.env` (repo root) and `apps/world/.env` are gitignored — never commit or print them.
- **CORS is an allowlist (not wildcard) since M2-G**: `CORS_ORIGINS` (comma-separated, exact-origin match) must be set on the `world` Railway service to the deployed Vercel origin(s), or the live frontend's cross-origin reads are blocked while localhost still works — the classic "works locally, dead in prod" trap. Unset → localhost dev default only. Rate limits + session caps are in-memory (`src/http/rate-limit.ts`, reset on restart — fine for a portfolio).

## Stack decisions (full rationale in the plan §2)

TypeScript pnpm monorepo (`apps/web` = this frontend, `apps/world` = new server, `packages/contract` = shared zod schemas) · Railway monolith + Postgres/pgvector, frontend stays on Vercel · SSE for realtime · **Anthropic SDK's built-in tool runner** (`client.beta.messages.toolRunner()` + `betaZodTool`) for the agent loop — we own the world/scheduler/prompt, never hand-roll the dispatch loop · Haiku 4.5 idle ticks / Opus 4.8 visitor chat · memory = per-agent core files (`betaMemoryTool`) + **Hindsight** (self-hosted, verbatim mode) for episodic · Obsidian vault synced via obsidian-git → private repo · Resend (in + out) · Langfuse (v4 OTel) · OpenAI embeddings only.

**Anthropic/Claude work**: the `claude-api` skill is the authority on model IDs, the tool runner, caching, streaming, structured outputs — consult it, don't answer from memory. Current models: Opus 4.8 (`claude-opus-4-8`), Haiku 4.5 (`claude-haiku-4-5`), Sonnet 4.6 (`claude-sonnet-4-6`).

## Git conventions (from Thomas's global rules)

- **Never commit on `main`.** Before any commit: `git fetch origin && git checkout -b thomas/<feature> origin/main`. Every branch must start with `thomas/`.
- PRs are always drafts, titled `[DRAFT] …` (`gh pr create --draft`).
- Durable narrative docs (designs, investigations, plans) go in the **vault**, not `docs/` in the repo. Heavy/throwaway artifacts go in a gitignored `scratch/`.
- Update this CLAUDE.md when you learn something architectural that future sessions need; keep feature-specific detail in the vault plan.
