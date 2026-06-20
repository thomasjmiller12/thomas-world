// Portfolio proofs + the composed About hub (M2.2 — Part 3). Proofs are curated
// claims-with-evidence (Thomas-owned, not agent-authored). `buildAbout` composes
// the About hub payload: the overview/how-it-works prose, the five facets with
// their bios + linked proof/reference ids, and the featured cards. The About hub
// reads even when the agents are asleep — all of this is curated data, no LLM.

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { agentIds } from "@town/contract";
import type {
  AgentId,
  PortfolioProof,
  AboutResponse,
  AboutFacet,
} from "@town/contract";
import { db, schema } from "../db/client.js";
import { allAgents } from "./agents.js";
import { listReferences, featuredReferences } from "./references.js";
import { ABOUT_CONTENT } from "../db/portfolio-content.js";

const { portfolioProofs } = schema;
type Row = typeof portfolioProofs.$inferSelect;

export function rowToProof(r: Row): PortfolioProof {
  return {
    id: r.id,
    title: r.title,
    claim: r.claim,
    summary: r.summary,
    bodyMd: r.bodyMd,
    agentIds: (r.agentIds ?? []) as AgentId[],
    skills: (r.skills ?? []) as string[],
    artifactIds: (r.artifactIds ?? []) as string[],
    eventIds: (r.eventIds ?? []) as string[],
    referenceIds: (r.referenceIds ?? []) as string[],
    featured: r.featured,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface ProofFilters {
  agent?: AgentId | null;
  tag?: string | null; // matches a skill
  featured?: boolean | null;
}

export async function listProofs(filters: ProofFilters = {}, limit = 40): Promise<PortfolioProof[]> {
  const conds: SQL[] = [];
  if (filters.agent) {
    conds.push(sql`${portfolioProofs.agentIds} @> ${JSON.stringify([filters.agent])}::jsonb`);
  }
  if (filters.tag) {
    conds.push(sql`${portfolioProofs.skills} @> ${JSON.stringify([filters.tag])}::jsonb`);
  }
  if (filters.featured) conds.push(eq(portfolioProofs.featured, true));
  const rows = await db
    .select()
    .from(portfolioProofs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(portfolioProofs.featured), asc(portfolioProofs.sortOrder), desc(portfolioProofs.updatedAt))
    .limit(limit);
  return rows.map(rowToProof);
}

export async function getProof(id: string): Promise<PortfolioProof | null> {
  const [r] = await db.select().from(portfolioProofs).where(eq(portfolioProofs.id, id));
  return r ? rowToProof(r) : null;
}

export interface UpsertProofInput {
  id: string;
  title: string;
  claim: string;
  summary: string;
  bodyMd: string;
  agentIds?: AgentId[];
  skills?: string[];
  artifactIds?: string[];
  eventIds?: string[];
  referenceIds?: string[];
  featured?: boolean;
  sortOrder?: number;
}

export async function upsertProof(input: UpsertProofInput): Promise<void> {
  const values = {
    id: input.id,
    title: input.title,
    claim: input.claim,
    summary: input.summary,
    bodyMd: input.bodyMd,
    agentIds: input.agentIds ?? [],
    skills: input.skills ?? [],
    artifactIds: input.artifactIds ?? [],
    eventIds: input.eventIds ?? [],
    referenceIds: input.referenceIds ?? [],
    featured: input.featured ?? false,
    sortOrder: input.sortOrder ?? 0,
    updatedAt: new Date(),
  };
  await db
    .insert(portfolioProofs)
    .values(values)
    .onConflictDoUpdate({ target: portfolioProofs.id, set: { ...values } });
}

// Compose the About hub payload. Facets join the live agent roster (display
// names) with the curated bios + the proofs/references that mention each facet.
export async function buildAbout(): Promise<AboutResponse> {
  const [agents, allProofs, allRefs, featuredProofs, featuredRefs] = await Promise.all([
    allAgents(),
    listProofs({}, 100),
    listReferences({}, 200),
    listProofs({ featured: true }, 8),
    featuredReferences(8),
  ]);
  const nameById = new Map(agents.map((a) => [a.id as AgentId, a.displayName]));

  const facets: AboutFacet[] = agentIds.map((id) => ({
    agentId: id,
    displayName: nameById.get(id) ?? id,
    bio: ABOUT_CONTENT.bios[id] ?? "",
    referenceIds: allRefs.filter((r) => r.agentIds.includes(id)).map((r) => r.id),
    proofIds: allProofs.filter((p) => p.agentIds.includes(id)).map((p) => p.id),
  }));

  return {
    overview: ABOUT_CONTENT.overview,
    howItWorks: ABOUT_CONTENT.howItWorks,
    facets,
    featuredProofs,
    featuredReferences: featuredRefs,
  };
}
