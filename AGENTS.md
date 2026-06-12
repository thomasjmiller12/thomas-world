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
- **Agent minds** — five tick loops (soul file + core memory + episodic memory + Obsidian reference layer + Codex API).

Agents never see the frontend (no screenshots/pixels) — only the observation packet the world server hands them each tick. The frontend's existing `EventBus` is the seam: a new `WorldClient` will replace the scripted `AgentSimulator`/`simulation-scripts.ts` as the *source* of the same events the UI already consumes.

## Current state

- **V1 (this repo): frontend only.** Next.js 15 + Phaser 3 + TypeScript, React overlay for UI, static-exported to Vercel. Town + 4 interiors, player movement, door transitions, NPC chat — all behavior is **scripted simulation** (`src/game/systems/AgentSimulator.ts`, `src/game/data/simulation-scripts.ts`). No backend, DB, or LLM yet.
- **Design**: hi-fi mockups for the chat and activity-feed surfaces are in `design/town-concepts-handoff/` (open `project/Town Concepts.html` and the `screens/*.jsx`; `00 Design Approach.html` has the design system — palette, type, agent colors). These drive Milestone 2's UI.
- **Next step: Milestone 1** ("the town lives offline") — stand up the world server + 5 agents, soak for 48h, judge the activity log. Pre-reqs: account setup (§10 of the plan, in progress) + the monorepo restructure + soul-file skeletons. Start there.

## Stack decisions (full rationale in the plan §2)

TypeScript pnpm monorepo (`apps/web` = this frontend, `apps/world` = new server, `packages/contract` = shared zod schemas) · Railway monolith + Postgres/pgvector, frontend stays on Vercel · SSE for realtime · **Anthropic SDK's built-in tool runner** (`client.beta.messages.toolRunner()` + `betaZodTool`) for the agent loop — we own the world/scheduler/prompt, never hand-roll the dispatch loop · Haiku 4.5 idle ticks / Opus 4.8 visitor chat · memory = per-agent core files (`betaMemoryTool`) + **Hindsight** (self-hosted, verbatim mode) for episodic · Obsidian vault synced via obsidian-git → private repo · Resend (in + out) · Langfuse (v4 OTel) · OpenAI embeddings only.

**Anthropic/Codex work**: the `Codex-api` skill is the authority on model IDs, the tool runner, caching, streaming, structured outputs — consult it, don't answer from memory. Current models: Opus 4.8 (`Codex-opus-4-8`), Haiku 4.5 (`Codex-haiku-4-5`), Sonnet 4.6 (`Codex-sonnet-4-6`).

## Git conventions (from Thomas's global rules)

- **Never commit on `main`.** Before any commit: `git fetch origin && git checkout -b thomas/<feature> origin/main`. Every branch must start with `thomas/`.
- PRs are always drafts, titled `[DRAFT] …` (`gh pr create --draft`).
- Durable narrative docs (designs, investigations, plans) go in the **vault**, not `docs/` in the repo. Heavy/throwaway artifacts go in a gitignored `scratch/`.
- Update this AGENTS.md when you learn something architectural that future sessions need; keep feature-specific detail in the vault plan.
