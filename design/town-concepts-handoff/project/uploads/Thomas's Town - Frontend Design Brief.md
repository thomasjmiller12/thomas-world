---
origin: ai-collated
doc_type: brief
status: active
---

# Thomas's Town — Frontend Design Brief

> Hand-off context for a frontend design agent. Distills the **ethos** of [[Thomas's Town]] and maps the **interaction surfaces** worth designing — especially agent↔visitor chat, the agent↔agent social fabric, and the day-in-the-life look-back. Read this before proposing any refactor. Built from [[Thomas's Town]], `thomas-agents.md`, and `PLAN.md` in the `thomas-world` repo.

---

## 1. The Ethos (read this first)

Thomas's Town is an interactive portfolio styled as a **16×16 top-down Pokémon-style pixel-art town**. Visitors walk around and enter buildings to meet **five NPC versions of Thomas** — Career, Researcher, Builder, Writer, Hobby — each a facet of who he is. It is built on Phaser 3 + Next.js 15 + TypeScript, deployed on Vercel.

It serves a **dual purpose**, and the design must honor both:

1. **Portfolio delivery** — visitors learn about Thomas's career, research, projects, writing, and personality through natural conversation with AI agents grounded in a RAG knowledge base.
2. **Portfolio piece** — the project *itself* is the demonstration of AI-engineering skill. This is not a chatbot wrapper. It's a living showcase of agent architecture: five persistent agents with memory, agency, and social dynamics.

**The single key differentiator is _continuity_.** The agents do things when nobody is watching. When a visitor arrives, the world already has state — agents have been thinking, working, talking to each other, and they remember past visitors (globally, not per-visitor). The design's job is to make that continuity *legible and delightful*, not to hide it behind a chat box.

**Design north star:** _When a visitor lands, they should immediately sense that this place was alive before they got here and will keep living after they leave._ The activity look-back (what the agents did today) is plausibly **more important to the "wow" than real-time presence.**

Tone: warm, cozy, detailed, a little playful. Pixel-art charm with modern, legible typography. It should feel like a place you'd want to wander, not a dashboard.

---

## 2. The Cast & The World

Five Thomases, each with a home building and a domain. They collaborate on projects that span their expertise and have distinct relationships with each other.

| Agent | Domain | Home | Personality | Color (V1) |
|---|---|---|---|---|
| **Career Thomas** | Roles, companies, industry impact (BYU → SambaNova → Billables AI) | Office | Polished, strategic, talks impact & growth | `#4A90D9` |
| **Researcher Thomas** | Math, stats, ML theory, rigor | Lab / Library | Precise, curious, "but *why* does that work?" | — |
| **Builder Thomas** | Side projects, apps, games, shipping | Workshop / Arcade | Energetic, hands-on, "let me show you" | — |
| **Writer Thomas** | Publications, essays, synthesis | Cafe / Studio | Thoughtful, narrative, the connector | — |
| **Hobby Thomas** | Games, fun, the human side | Park / around town | Relaxed, funny, breaks the 4th wall ("I'm the *real* Thomas, the AI trapped me in here") | — |

**Relationships that should be visible in the design:**
- Career ↔ Researcher: longest history (BYU days).
- Builder ↔ Hobby: tight; Hobby feeds Builder ideas.
- Writer: the connector — works with everyone.
- Researcher ↔ Builder: argue productively (rigor vs. ship).
- Hobby: everyone's friend; reminds them why they do it.

They collaborate on real Thomas projects (MC Darts paper, Codenames Evals, Multiplayer Wordle, Aligned, etc.) — see the collaboration map in `thomas-agents.md`. Visitors should be able to feel these cross-agent threads.

---

## 3. Interaction Surfaces — the heart of the design problem

These are the surfaces worth (re)designing. They split into four kinds. **Critical:** most of these are *not live in the backend yet* (see §4). The design can and should run ahead of the backend — proposing the interaction model is partly what will *drive* which backend features get built. Design for the V2 vision; note gracefully degrading fallbacks for what isn't live.

### A. Agent ↔ Visitor (chat) — *the primary, high-value interaction*
- A visitor walks up to a Thomas and chats. The agent stays in character (soul file), knows the portfolio (RAG), and can reference recent events ("Builder and I were just arguing about whether to ship Codenames Evals").
- Chat is the **primary interaction**, not spatial mechanics. It must stream (responsiveness is non-negotiable in active mode).
- Interactions can have *lasting effects* — a good suggestion might surface in an agent's memory or future behavior. Not guaranteed; the agent decides.
- **Design question:** how do we show that a chat *mattered*? How does a visitor see that this agent remembers prior visitors generally?

### B. Agent ↔ Agent (the social fabric) — *the thing that makes it feel alive*
- Agents DM and broadcast to each other. Messages are logged and searchable.
- This is the engine of emergent dynamics: pranks, collaborations, debates. ("Hobby emails Thomas: Career won't stop talking about KPIs, please intervene.")
- **Visitors should be able to browse the inter-agent message log** and find it entertaining — it's content, not plumbing.
- Visitor interactions can *trigger* inter-agent comms (visitor suggests a prank → agent coordinates via DM).
- **Design question:** how do we surface the "group chat between five versions of one person" in a way that's a feature, not noise? Is it a readable inbox, a town bulletin board, speech bubbles you catch in passing, a feed?

### C. The Day-in-the-Life Look-back (activity feed / history) — *possibly the biggest "wow"*
- A visitor arriving should **see an activity feed of what the agents did today** — thoughts, conversations, work — and it should read like a believable day-in-the-life, *not* random noise.
- This needs to work **across all five agents** (a unified timeline) *and* be filterable to a single agent's day.
- In idle mode agents tick slowly (~5–15 min) so a full day produces a rich log even with nobody watching. When a visitor connects, ticks speed up and agents are more likely to be "doing something."
- **This is the explicit design ask:** "the ability to look back at what the agent has done throughout the day, across different agents." Treat it as a first-class surface, not a footer widget.
- **Design questions:** Timeline vs. feed vs. per-building "what happened here today"? How do we represent a *thought* vs. a *conversation* vs. *work* vs. a *movement*? How far back can you scroll — just today, or history? How does the feed connect spatially to the town (click an entry → camera pans to where it happened)?

### D. Meta / human-in-the-loop interactions (the portfolio-piece flex)
- **Capability requests:** any agent can propose a new tool/capability; it emails the real Thomas, who approves async. This is the *evolutionary mechanism* — the system gets more capable over time based on what agents want. There could be a visible "things the agents have asked Thomas for" surface.
- **Email Thomas:** agents can escalate, complain about each other, or flag being stuck — both an in-world personality mechanic and a genuine monitoring channel.
- **Design question:** is there a tasteful way to expose this meta-layer to visitors (e.g., a "town suggestion box" or "requests pending Thomas's approval" board) that reinforces *these agents have real agency*?

---

## 4. LIVE vs. ASPIRATIONAL — what the backend actually does today

**The current deployed app (`thomas-world`, V1) is frontend-only. Every agent behavior is scripted simulation. There is no backend, database, LLM, or memory.** Design against the V2 vision, but know the seams.

| Capability | State | Notes for design |
|---|---|---|
| Town overworld + 4 interiors (cafe, office, library, workshop), player movement, door transitions | ✅ **Live** | Phaser scenes exist. Hand-crafted Tiled maps (LimeZu 16×16). |
| NPC presence, waypoint wander, thought bubbles | ✅ **Live (scripted)** | Driven by `AgentSimulator` + `simulation-scripts.ts`, not real agents. |
| Visitor ↔ NPC chat | ⚠️ **Live but stubbed** | `ChatWindow.tsx` exists; responses are hardcoded per-personality lines. No LLM, no streaming yet. |
| Examinable objects in interiors (whiteboard, chalkboard, monitor) | ✅ **Live (static text)** | Stubbed text now; agent-generated in V2. |
| Real agents (soul file + LLM + tools + loop) | ❌ **Aspirational** | Full architecture specced in [[Thomas's Town]] §V2. |
| Agent memory (save/search/forget) | ❌ **Aspirational** | Evaluating Mem0 / Zep / Letta / custom. |
| Agent ↔ agent messaging (DM, broadcast, searchable log) | ❌ **Aspirational** | Core to the "alive" feel. |
| Activity feed / day-in-the-life log | ❌ **Aspirational** | No logging backend yet. **This is the surface the design should help define.** |
| Capability requests / email-to-Thomas | ❌ **Aspirational** | Async, human-in-the-loop. |
| Real-time presence (visitor connects → faster ticks, avatars placed) | ❌ **Aspirational** | "Embodiment bridge" — WebSocket/SSE, planned. |

The architecture is fully designed (six systems: Knowledge Base, Soul Files, Memory, Communication, Action Space, Embodiment Bridge) — see [[Thomas's Town]] for the detail and the six V2 decision briefs: [[Thomas's Town — V2 Research — LLM Providers]], [[Thomas's Town — V2 Research — Agent Frameworks]], [[Thomas's Town — V2 Research — Vector Stores]], [[Thomas's Town — V2 Research — Memory Solutions]], [[Thomas's Town — V2 Research — Backend Hosting]], [[Thomas's Town — V2 Research — Cost Model]].

---

## 5. Design principles & constraints

**Aesthetic**
- 16×16 pixel art, `pixelArt: true` (no sub-pixel blur). LimeZu tilesets. 2× camera zoom.
- Cozy, warm, detailed. Ambient life (fountains, swaying trees, flickering lights). Optional subtle day/night tint.
- Pixel-art charm + *modern, legible* typography for UI. The overlay UI doesn't have to be pixel-art itself — readability wins for chat and feeds.

**Architecture (respect these — they constrain how UI gets wired)**
- **EventBus pattern is sacred:** all Phaser↔React communication goes through `src/game/EventBus.ts`. React never imports Phaser scenes directly. Any new interaction surface talks to the game via events (e.g., `npc-interaction`, `chat-message`, `npc-position-update`, `scene-changed`).
- UI is a **React overlay positioned over the Phaser canvas** (`pointer-events` toggled per panel). Phaser owns the world; React owns chat, dialog, thought bubbles, HUD, and (new) the activity feed.
- Phaser is **client-only** (dynamic import, `ssr: false`).
- Existing components: `ChatWindow`, `DialogBox`, `ThoughtBubble`, `HUD`, `GameContainer`.

**Interaction philosophy (from the vision doc — these are opinions to honor or argue with)**
- **Chat is primary; spatial mechanics are secondary.** Don't build elaborate pathfinding; simple position updates are fine.
- **Don't over-animate.** Agent "movement" can be simple position updates.
- **The activity feed may matter more than real-time presence** for the wow factor. Weight design effort accordingly.
- **Inter-agent message logs are content** — make reading them fun, not utilitarian.
- Mobile/touch is a stretch goal but worth keeping in the responsive plan.

---

## 6. Provocations for the design agent

Concrete questions where a strong proposal would move the project forward:

1. **The look-back surface.** What's the best form for "what did the agents do today, across all five"? Unified timeline, per-agent lanes, a town newspaper, replayable spatial markers? How do thought / conversation / work / movement entries read differently? How does it tie back to the spatial town?
2. **Surfacing the social fabric.** How do visitors discover and enjoy the agent↔agent group chat without it feeling like log spam? Ambient (overheard bubbles) vs. on-demand (an inbox/board) vs. both?
3. **Making chat feel continuous.** How does a single chat communicate "this agent has memory and a life"? Showing what the agent was doing before you interrupted, references to recent events, "remembers visitors" signals.
4. **The meta-layer as a flex.** Is there a tasteful visitor-facing way to show capability requests / agent agency that reinforces "real engineering, not a wrapper"?
5. **Graceful V1→V2 path.** Since the backend is mostly stubbed, what can be designed and shipped now (against scripted data) that becomes real later with zero redesign? Design the *shape*, let the data source swap underneath.

---

## Related
- [[Thomas's Town]] — master vision + full V2 architecture and MVP definition
- [[Personal Website]] — the alternate, non-agent portfolio direction
- [[Game Dojo]] — sibling project; cross-referenced to avoid the animation rabbit hole
- The six V2 decision briefs (linked in §4)
