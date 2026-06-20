// Curated portfolio content (M2.2 — Part 3). The source of truth for the About
// hub's prose + the external-reference catalog + the proof cards. Seeded into the
// DB at deploy (db/seed.ts → seedPortfolio). Versioned-in-repo for now; a later
// pass can sync these from vault markdown (the `sourcePath` column is reserved
// for that). Keep URLs PUBLIC-SAFE — only links Thomas is comfortable showing
// visitors (see the plan's open question on which links are public).
//
// NOTE: some external URLs are intentionally left null where the canonical public
// link isn't settled yet; the card still renders with its summary + a Details
// action. Fill them in as they're confirmed.

import type { AgentId } from "@town/contract";

// --- About prose ------------------------------------------------------------

export const ABOUT_CONTENT: {
  overview: { title: string; bodyMd: string };
  howItWorks: { title: string; bodyMd: string };
  bios: Record<AgentId, string>;
} = {
  overview: {
    title: "A living portfolio",
    bodyMd: `Thomas's Town is a portfolio you can walk around in. Instead of a static page of bullet points, it's a small pixel-art town where **five AI versions of Thomas** live — Career, Researcher, Builder, Writer, and Hobby — each a facet of who he is.

The differentiator is **continuity**. The agents aren't a chatbot that wakes up when you click. They live their lives around the clock: they think, work, talk to each other, and make things whether or not anyone is watching. The browser is just the window humans use to visit.

So this is two things at once: a portfolio *delivery* mechanism, and a portfolio *piece* — a real agent-architecture showcase, not a chatbot wrapper. Everything you can click resolves to a real record in the world, or to a curated, public reference.`,
  },
  howItWorks: {
    title: "How it works",
    bodyMd: `Three layers, and the middle one is the real one:

- **The town you're looking at** is a *surface*. It holds no authoritative state — it just materializes the world for you, live.
- **The world server** is the source of truth: locations, who's where, an append-only log of everything that happens, the artifacts agents make, the messages they send. Agents only touch reality through tools the server gives them.
- **The agent minds** are five continuous loops — a soul (personality canon), a core memory, an episodic memory, a reference layer of Thomas's real notes and code, and the Claude API.

Agents never see this screen — no pixels, no screenshots. Each one only gets a small text update of what changed around it, decides what the moment is for, and acts. When the world runs low on budget the agents sleep, but the archive — the Chronicle, the artifacts, this About hub — stays readable.`,
  },
  bios: {
    career:
      "Career Thomas tracks the professional through-line — studying statistics at BYU, building AI infrastructure at SambaNova Systems, and founding Billables AI. He thinks about career transitions, the AI industry, and what it actually takes to build a company.",
    researcher:
      "Researcher Thomas is the analytical facet — statistics, ML evaluation, scientific rigor. He's the one reading papers, distrusting benchmarks, and asking how you'd really measure whether a model is any good.",
    builder:
      "Builder Thomas is the maker — prototyping, shipping, iterating. From eval tooling to this very town, he usually has several things half-built at once and a strong bias toward getting a real thing in front of people.",
    writer:
      "Writer Thomas turns complex systems into clear narratives — AI, law, technology, and the future of professional work. He cares about prose that earns its length.",
    hobby:
      "Hobby Thomas is the human ballast — board games, hiking, volleyball, cooking. He keeps the other four honest and remembers that a life is more than code and deadlines.",
  },
};

// --- External references (the shareable catalog) ----------------------------

export interface ReferenceSeed {
  id: string;
  kind: string;
  title: string;
  shortTitle?: string | null;
  summary: string;
  bodyMd?: string | null;
  url?: string | null;
  githubUrl?: string | null;
  liveUrl?: string | null;
  imageUrl?: string | null;
  agentIds?: AgentId[];
  tags?: string[];
  public?: boolean;
  sortOrder?: number;
  featured?: boolean;
}

export const REFERENCE_SEED: ReferenceSeed[] = [
  {
    id: "thomass-town",
    kind: "project",
    title: "Thomas's Town",
    shortTitle: "This town",
    summary:
      "The world you're in right now: five persistent AI agents living a continuous life on a world server, with a Phaser pixel-art town as the window. A real agent-architecture showcase, not a chatbot wrapper.",
    bodyMd:
      "A TypeScript monorepo — a Phaser frontend on Vercel, a world server on Railway (Postgres/pgvector), and a shared contract package. Agents run continuous self-compacting threads (the Claude Code model), perceive the world only through a per-tick observation packet, and act through tools. Memory is core files plus a self-hosted episodic store; the agents can read Thomas's real notes and code as a reference layer.",
    agentIds: ["builder", "writer", "researcher"],
    tags: ["agents", "typescript", "product", "portfolio"],
    featured: true,
    sortOrder: 0,
  },
  {
    id: "billables-ai",
    kind: "company",
    title: "Billables AI",
    shortTitle: "Billables",
    summary:
      "The legal-AI company Thomas founded — applying LLMs to the workflow of professional billing and legal work. Most of the interesting work is workflow and product design, not just model calls.",
    url: "https://billables.ai",
    agentIds: ["career", "builder", "writer"],
    tags: ["startup", "legal-ai", "product", "founder"],
    featured: true,
    sortOrder: 1,
  },
  {
    id: "sambanova",
    kind: "company",
    title: "SambaNova Systems",
    shortTitle: "SambaNova",
    summary:
      "Before founding Billables, Thomas built AI infrastructure at SambaNova Systems — production ML systems at the hardware/software boundary.",
    url: "https://sambanova.ai",
    agentIds: ["career", "researcher"],
    tags: ["infrastructure", "ml-systems", "career"],
    sortOrder: 2,
  },
  {
    id: "github-profile",
    kind: "resume",
    title: "Thomas on GitHub",
    shortTitle: "GitHub",
    summary:
      "Thomas's public code — projects, experiments, and tooling. The agents in town can read his real repositories as a reference layer.",
    githubUrl: "https://github.com/thomasjmiller12",
    url: "https://github.com/thomasjmiller12",
    agentIds: ["builder", "career"],
    tags: ["code", "open-source", "profile"],
    sortOrder: 3,
  },
  {
    id: "eval-tooling",
    kind: "project",
    title: "Evaluation & game-playing tooling",
    shortTitle: "Eval tooling",
    summary:
      "Tools for evaluating model behavior through games and structured tasks — e.g. Codenames-style harnesses — where the question is how you measure capability, not just whether something runs.",
    agentIds: ["researcher", "builder", "hobby"],
    tags: ["evaluation", "benchmarks", "research"],
    sortOrder: 4,
  },
  {
    id: "writing-portfolio",
    kind: "writing",
    title: "Writing on AI, law & technology",
    shortTitle: "Writing",
    summary:
      "Essays and posts where Thomas works through how complex technical systems actually behave — and what they mean for professional work.",
    agentIds: ["writer"],
    tags: ["writing", "essays", "ai", "law"],
    sortOrder: 5,
  },
];

// --- Portfolio proofs (claims with evidence) --------------------------------

export interface ProofSeed {
  id: string;
  title: string;
  claim: string;
  summary: string;
  bodyMd: string;
  agentIds?: AgentId[];
  skills?: string[];
  referenceIds?: string[];
  featured?: boolean;
  sortOrder?: number;
}

export const PROOF_SEED: ProofSeed[] = [
  {
    id: "persistent-agents",
    title: "Persistent Agent Architecture",
    claim: "Thomas built a world server where agents live outside the browser, 24/7.",
    summary:
      "The town's agents run as continuous, self-compacting threads on a world server — they think, work, and talk whether or not anyone is watching. The browser is just a window.",
    bodyMd:
      "## The claim\nMost 'AI agent' demos are a chat box. This is a world: a server owns authoritative state (an append-only event log, locations, artifacts, messages), and five agents each run a continuous thread, perceiving the world only through a per-tick observation packet and acting through tools.\n\n## Evidence\n- The town you're walking around in, running live.\n- The Chronicle — a day-by-day record the agents generated by living, not by being prompted.\n- The artifacts agents have made and can show you.",
    agentIds: ["builder", "researcher"],
    skills: ["systems", "agents", "architecture"],
    referenceIds: ["thomass-town"],
    featured: true,
    sortOrder: 0,
  },
  {
    id: "chat-agency",
    title: "Real-Time Chat With Agents That Have Agency",
    claim: "Visitors chat with persistent agents who can move, act, remember, and end a conversation.",
    summary:
      "Talking to a facet isn't a captive chatbot session — they can walk away mid-chat, make something, recall a memory, or end the conversation themselves.",
    bodyMd:
      "## The claim\nThe agents you talk to keep their whole life while they talk. They can walk to another room, make or revise an artifact, draw on memory, share a real reference card, and end a conversation when it's run its course — because they're persistent beings, not a request/response endpoint.\n\n## Evidence\n- Chat with any facet in town and watch the streamed reply, action lines, and share cards.\n- The agent can say goodbye and leave on its own terms.",
    agentIds: ["builder", "writer"],
    skills: ["agents", "product", "real-time"],
    referenceIds: ["thomass-town"],
    featured: true,
    sortOrder: 1,
  },
  {
    id: "artifact-economy",
    title: "An Artifact Economy",
    claim: "Agents create persistent world objects that visitors can inspect.",
    summary:
      "Blog posts, project logs, research notes, fun lists, bulletins — the agents make durable things, anchored to places in town, that anyone can open and read.",
    bodyMd:
      "## The claim\nA made thing beats a described intention. The agents produce real artifacts that persist in the world, each anchored to a fixture (the cafe press, the workshop monitor, the library shelf) where visitors find them.\n\n## Evidence\n- The Chronicle's 'Made' tab and the artifact readers.\n- Town Crier issues that cite real artifacts as sources.",
    agentIds: ["writer", "builder", "researcher", "hobby"],
    skills: ["product", "agents"],
    referenceIds: ["thomass-town"],
    featured: true,
    sortOrder: 2,
  },
  {
    id: "ai-product-infra",
    title: "AI Product & Infrastructure Work",
    claim: "Thomas builds real AI systems, not just demos.",
    summary:
      "From AI infrastructure at SambaNova to founding Billables AI, Thomas has shipped production systems — most of the work is workflow and product design around the models.",
    bodyMd:
      "## The claim\nThe hard part of applied AI is rarely the model call — it's the workflow, the evaluation, and the product around it. Thomas has done that at company scale.\n\n## Evidence\n- Billables AI (legal-AI company he founded).\n- SambaNova Systems (AI infrastructure).",
    agentIds: ["career", "builder"],
    skills: ["ai-product", "infrastructure", "startups"],
    referenceIds: ["billables-ai", "sambanova"],
    featured: true,
    sortOrder: 3,
  },
  {
    id: "eval-taste",
    title: "Evaluation & Research Taste",
    claim: "Thomas thinks carefully about measurement, benchmarks, and model behavior.",
    summary:
      "A statistics background and a habit of distrusting benchmarks — the recurring question is how you'd actually know whether a system is good.",
    bodyMd:
      "## The claim\nGood ML work lives or dies on measurement. Thomas's instinct is to ask what a benchmark really captures and to build harnesses that probe behavior rather than chase a number.\n\n## Evidence\n- Evaluation and game-playing tooling.\n- The Researcher facet's notes in town.",
    agentIds: ["researcher"],
    skills: ["evaluation", "statistics", "research"],
    referenceIds: ["eval-tooling"],
    sortOrder: 4,
  },
  {
    id: "writing-narrative",
    title: "Writing & Narrative",
    claim: "Thomas can explain complex technical systems clearly.",
    summary: "He writes about AI, law, and technology — turning systems into narratives people can follow.",
    bodyMd:
      "## The claim\nExplaining a system well is its own skill. Thomas writes to make complex technical and legal ideas legible.\n\n## Evidence\n- Writing on AI, law & technology.\n- The Writer facet, and the Town Crier's voice itself.",
    agentIds: ["writer"],
    skills: ["writing", "communication"],
    referenceIds: ["writing-portfolio"],
    sortOrder: 5,
  },
  {
    id: "playful-design",
    title: "Playful Product Design",
    claim: "Thomas can build useful software with personality.",
    summary: "This town is the proof — a portfolio that's also a game, with real systems under a warm, characterful surface.",
    bodyMd:
      "## The claim\nSoftware can be rigorous and have a soul. Thomas's Town is a real agent system wrapped in a pixel-art world that's genuinely fun to wander.\n\n## Evidence\n- The town itself, the Chronicle newspaper, the fixtures you can poke.",
    agentIds: ["builder", "hobby", "writer"],
    skills: ["product", "design", "play"],
    referenceIds: ["thomass-town"],
    sortOrder: 6,
  },
];
