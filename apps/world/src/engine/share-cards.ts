// Share cards (M2.2 — Part 4). Builds the one ShareCard shape from real records
// — an agent's artifact, a curated external reference, or a portfolio proof —
// for the chat share tools. The server owns card construction and the allowlist
// check, so agents share by id and can never emit an arbitrary URL. Also powers
// `search_shareables`, the read-only "what can I show this visitor" lookup.

import type {
  AgentId,
  ShareCard,
  ShareCardAction,
  ExternalReference,
  PortfolioProof,
} from "@town/contract";
import { getArtifact, listArtifacts } from "./artifacts.js";
import { getReferenceRow, listReferences, rowToReference } from "./references.js";
import { getProof, listProofs } from "./portfolio.js";

// Human label for an artifact kind (mirrors the frontend's chroniclePresentation).
const ARTIFACT_KIND_LABELS: Record<string, string> = {
  blog_post: "Blog Post",
  project_log: "Project Log",
  research_note: "Research Note",
  bulletin: "Bulletin",
  fun_list: "List",
  diary_entry: "Diary",
  daily_digest: "Digest",
};
function artifactKindLabel(kind: string): string {
  return ARTIFACT_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

// Agent hue map (mirrors the frontend THOMAS_COLORS — the card carries the color
// so a rehydrated transcript keeps the accent without a frontend lookup).
const AGENT_COLORS: Record<AgentId, string> = {
  career: "#4A90D9",
  researcher: "#9B59B6",
  builder: "#E67E22",
  writer: "#27AE60",
  hobby: "#E74C3C",
};

function colorFor(agentId: AgentId | null): string | null {
  return agentId ? AGENT_COLORS[agentId] ?? null : null;
}

// A short plain-text snippet from a markdown body (strip headings/markup, cap).
function snippet(md: string, max = 200): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

const REFERENCE_KIND_LABELS: Record<string, string> = {
  project: "Project",
  repo: "Repository",
  demo: "Live Demo",
  writing: "Writing",
  resume: "Résumé",
  company: "Company",
  case_study: "Case Study",
  other: "Reference",
};

// --- builders ---------------------------------------------------------------

// An artifact card. Validates the artifact exists; returns null if not (the tool
// surfaces an in-fiction error). Private artifacts would be refused here (none
// today — all artifacts are world-visible).
export async function shareCardFromArtifact(artifactId: string): Promise<ShareCard | null> {
  const a = await getArtifact(artifactId);
  if (!a) return null;
  const agentId = a.agentId as AgentId;
  return {
    id: `artifact:${a.id}`,
    kind: "artifact",
    title: a.title,
    subtitle: null,
    summary: snippet(a.body),
    agentId,
    color: colorFor(agentId),
    imageUrl: null,
    sourceLabel: artifactKindLabel(a.kind),
    actions: [{ label: "Read", href: `artifact:${a.id}`, kind: "internal" }],
    metadata: { artifactKind: a.kind, published: a.published },
  };
}

function referenceActions(ref: ExternalReference): ShareCardAction[] {
  const actions: ShareCardAction[] = [];
  if (ref.liveUrl) actions.push({ label: "Live demo", href: ref.liveUrl, kind: "external" });
  if (ref.githubUrl) actions.push({ label: "GitHub", href: ref.githubUrl, kind: "external" });
  if (ref.url) {
    const label = ref.kind === "writing" ? "Read" : ref.kind === "resume" ? "Open résumé" : "Open project";
    actions.push({ label, href: ref.url, kind: "external" });
  }
  // An internal action always present so the card can open its own reader.
  actions.push({ label: "Details", href: `reference:${ref.id}`, kind: "internal" });
  return actions;
}

export function shareCardFromReference(ref: ExternalReference): ShareCard {
  const agentId = ref.agentIds[0] ?? null;
  return {
    id: `reference:${ref.id}`,
    kind: "external_reference",
    title: ref.title,
    subtitle: ref.shortTitle,
    summary: ref.summary,
    agentId,
    color: colorFor(agentId),
    imageUrl: ref.imageUrl,
    sourceLabel: REFERENCE_KIND_LABELS[ref.kind] ?? "Reference",
    actions: referenceActions(ref),
    metadata: { referenceKind: ref.kind, tags: ref.tags },
  };
}

export function shareCardFromProof(proof: PortfolioProof): ShareCard {
  const agentId = proof.agentIds[0] ?? null;
  const actions: ShareCardAction[] = [
    { label: "View proof", href: `proof:${proof.id}`, kind: "internal" },
  ];
  for (const refId of proof.referenceIds.slice(0, 2)) {
    actions.push({ label: "Related project", href: `reference:${refId}`, kind: "internal" });
  }
  return {
    id: `proof:${proof.id}`,
    kind: "portfolio_proof",
    title: proof.title,
    subtitle: proof.claim,
    summary: proof.summary,
    agentId,
    color: colorFor(agentId),
    imageUrl: null,
    sourceLabel: "Proof",
    actions,
    metadata: { skills: proof.skills },
  };
}

// `share_reference` / `share_proof` entry points used by the tools — resolve +
// allowlist-check, return a card or null.
export async function shareCardForReferenceId(referenceId: string): Promise<ShareCard | null> {
  const row = await getReferenceRow(referenceId);
  if (!row || !row.public) return null;
  return shareCardFromReference(rowToReference(row));
}

export async function shareCardForProofId(proofId: string): Promise<ShareCard | null> {
  const proof = await getProof(proofId);
  if (!proof) return null;
  return shareCardFromProof(proof);
}

// --- search -----------------------------------------------------------------

export type ShareableKind = "artifact" | "portfolio_proof" | "external_reference";

export interface ShareableHit {
  // The id the agent passes to a share tool (raw id, not the card's prefixed id).
  shareId: string;
  kind: ShareableKind;
  title: string;
  summary: string;
  // Which tool shares this hit.
  tool: "share_artifact" | "share_reference" | "share_proof";
  label: string; // a short "[kind/subkind]" badge for the listing
}

export interface SearchShareablesOpts {
  query: string;
  kinds?: ShareableKind[];
  agent?: AgentId;
  tags?: string[];
  limit?: number;
}

// Search the three shareable catalogs. Returns hits across kinds, ranked roughly
// by catalog order (references/proofs are curated; artifacts come last). A blank
// query lists the top curated items so an agent can browse.
export async function searchShareables(opts: SearchShareablesOpts): Promise<ShareableHit[]> {
  const limit = Math.min(opts.limit ?? 8, 20);
  const want = (k: ShareableKind) => !opts.kinds || opts.kinds.includes(k);
  const q = opts.query.trim().toLowerCase();
  const tag = opts.tags?.[0] ?? null;
  const hits: ShareableHit[] = [];

  if (want("external_reference")) {
    const refs = await listReferences({ q: opts.query || null, agent: opts.agent ?? null, tag }, 30);
    for (const r of refs) {
      hits.push({
        shareId: r.id,
        kind: "external_reference",
        title: r.title,
        summary: r.summary,
        tool: "share_reference",
        label: `external_reference/${r.kind}`,
      });
    }
  }

  if (want("portfolio_proof")) {
    const proofs = await listProofs({ agent: opts.agent ?? null, tag }, 30);
    for (const p of proofs) {
      if (q && !`${p.title} ${p.claim} ${p.summary}`.toLowerCase().includes(q)) continue;
      hits.push({
        shareId: p.id,
        kind: "portfolio_proof",
        title: p.title,
        summary: p.summary,
        tool: "share_proof",
        label: "portfolio_proof",
      });
    }
  }

  if (want("artifact")) {
    const arts = await listArtifacts({ agent: opts.agent }, 60);
    for (const a of arts) {
      if (q && !a.title.toLowerCase().includes(q)) continue;
      if (a.kind === "diary_entry") continue; // private-feeling; not a portfolio card
      hits.push({
        shareId: a.id,
        kind: "artifact",
        title: a.title,
        summary: artifactKindLabel(a.kind),
        tool: "share_artifact",
        label: `artifact/${a.kind}`,
      });
    }
  }

  return hits.slice(0, limit);
}

// Render search hits as the tool's text result.
export function renderShareableHits(hits: ShareableHit[]): string {
  if (hits.length === 0) {
    return "No shareable references match that. You can answer from your own context, but say you don't have a card to share yet (you can request one via the office outbox).";
  }
  const lines = hits.map((h, i) => {
    const idHint =
      h.tool === "share_artifact"
        ? `share_artifact id ${h.shareId}`
        : h.tool === "share_reference"
          ? `share_reference id ${h.shareId}`
          : `share_proof id ${h.shareId}`;
    return `${i + 1}. [${h.label}] ${h.title} — ${h.summary} (${idHint})`;
  });
  return `Found ${hits.length} shareable${hits.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}
