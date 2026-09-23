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
- **World server** (`apps/world`, live) — the embodiment layer and source of truth: locations, agent positions/status, co-presence, an append-only `world_events` log, artifacts, messages. Agents touch reality **only** through tools.
- **Agent minds** — five continuous input-driven loops (soul file + core memory + provider-native living thread + episodic memory + Obsidian reference layer), run through the boot-selected Anthropic or OpenAI adapter.

Agents never see the frontend (no screenshots/pixels) — only the world delta the server gives their continuous thread and the tools they call. The frontend's `WorldClient` materializes snapshots and SSE events without owning authoritative state.

## Current state

- The pnpm monorepo is live: `apps/web` is the Next.js/Phaser surface on Vercel, `apps/world` is the Railway world server, and `packages/contract` is their shared Zod contract.
- Each facet has one serialized, continuous thread driven by ticks, visitor inputs, reflection, and delivery. `runtime/turn.ts` is provider-neutral; SDK-specific dispatch/history/tools/usage live only under `runtime/llm/anthropic/` or `runtime/llm/openai/`.
- The provider abstraction is deployed on Railway production from `thomas/model-provider-abstraction`. Migrations `0017_quiet_flatman.sql` and `0018_llm_provider_keys.sql` are live, production selects `LLM_PROVIDER=openai` with `gpt-5.4`, and a two-turn Builder smoke proved native-thread persistence/resume. The five Anthropic thread rows remain intact for rollback. See [[Thomas's Town — OpenAI-Anthropic Provider Abstraction Implementation Plan]].
- Provider-native histories are opaque and separate by `(agent_id, provider)`. Never translate, merge, or delete the inactive provider's thread. Shared continuity lives in soul/core memory/Hindsight/diaries/artifacts/world state. Only explicit adapter-classified native-history corruption may reseed the selected provider row.
- OpenAI strict tool schemas must be closed and tuple-free: do not use an open `z.record(...)` or `z.tuple(...)` in the OpenAI function-tool wire shape. `runtime/llm/openai/tools.test.ts` converts the complete production tool surface and rejects tuple-form `items`; keep that regression test current when tools change.
- `world.phase` controls day/night presentation and the scheduler's passive-tick window; `world.awake` means visitor-interactive availability and must not become false merely because it is night. Visitor chat is interrupt-driven and remains available overnight unless the hard daily budget is exhausted.
- Visitor room chat is canonical world state: `chat_session_participants` owns the active roster (one visitor + at most two facets), `chat_messages` is one private shared transcript, and `chat_sessions.agent_id` is only the stable opening facet/back-compat attribution. A visitor message is persisted once, directed to the explicit/named/last speaker, then the other member gets one bounded tool-free `[pass]` interjection opportunity. `done` closes one speaker turn; `response_done` closes the whole visitor response. Nonmember `agent.spoke` remains ambient canvas speech and must never be inserted into the private transcript.

## Stack decisions (full rationale in the plan §2)

TypeScript pnpm monorepo (`apps/web`, `apps/world`, `packages/contract`) · Railway monolith + Postgres/pgvector · Vercel frontend · SSE · boot-time `LLM_PROVIDER=anthropic|openai` · Anthropic SDK tool runner or OpenAI Agents SDK/Responses behind one provider interface · provider-specific native compaction/history · provider-neutral town tools · `claude-sonnet-5` or `gpt-5.4` for agent tick/chat roles · core-memory command semantics shared across adapters · Hindsight episodic memory (OpenAI embeddings) · Obsidian vault sync · Resend · Langfuse OTel.

For model/API behavior, check current official provider documentation and the pinned SDK types/fixtures; do not answer from remembered model IDs or wire formats. The selected provider must never silently fall back to the other provider.

## Git conventions (from Thomas's global rules)

- **Never commit on `main`.** Before any commit: `git fetch origin && git checkout -b thomas/<feature> origin/main`. Every branch must start with `thomas/`.
- PRs are always drafts, titled `[DRAFT] …` (`gh pr create --draft`).
- Durable narrative docs (designs, investigations, plans) go in the **vault**, not `docs/` in the repo. Heavy/throwaway artifacts go in a gitignored `scratch/`.
- Update this AGENTS.md when you learn something architectural that future sessions need; keep feature-specific detail in the vault plan.
