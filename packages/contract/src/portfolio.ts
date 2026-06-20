import { z } from "zod";
import { AgentId } from "./ids.js";

// Portfolio surfaces (M2.2 — Part 3). Two curated, Thomas-owned (not agent-
// authored) catalogs the About hub renders and the share tools draw from:
//
//  - external_references: public projects / repos / demos / writing / resume
//    entries an agent can share as a card. The catalog is an ALLOWLIST — only
//    `public` references are shareable, and agents pass ids, never raw URLs.
//  - portfolio_proofs: claims ("Thomas built a persistent agent architecture")
//    backed by evidence links (artifacts, world events, references).
//
// Both are seeded from curated source data and loaded into the DB at boot, so
// the About hub stays readable even when the agents are asleep / credits are out.

export const ExternalReferenceKind = z.enum([
  "project",
  "repo",
  "demo",
  "writing",
  "resume",
  "company",
  "case_study",
  "other",
]);
export type ExternalReferenceKind = z.infer<typeof ExternalReferenceKind>;

export const ExternalReference = z.object({
  id: z.string(),
  kind: ExternalReferenceKind,
  title: z.string(),
  shortTitle: z.string().nullable(),
  summary: z.string(),
  bodyMd: z.string().nullable(),
  url: z.string().nullable(),
  githubUrl: z.string().nullable(),
  liveUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  agentIds: z.array(AgentId),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});
export type ExternalReference = z.infer<typeof ExternalReference>;

export const PortfolioProof = z.object({
  id: z.string(),
  title: z.string(),
  claim: z.string(),
  summary: z.string(),
  bodyMd: z.string(),
  agentIds: z.array(AgentId),
  skills: z.array(z.string()),
  artifactIds: z.array(z.string()),
  eventIds: z.array(z.string()),
  referenceIds: z.array(z.string()),
  featured: z.boolean(),
  updatedAt: z.string(),
});
export type PortfolioProof = z.infer<typeof PortfolioProof>;

// --- GET /portfolio/about ---------------------------------------------------
// A composed object for the About hub: the overview prose, the five facets with
// their static bios + linked proof/reference ids, and the featured cards.

export const AboutFacet = z.object({
  agentId: AgentId,
  displayName: z.string(),
  bio: z.string(),
  referenceIds: z.array(z.string()),
  proofIds: z.array(z.string()),
});
export type AboutFacet = z.infer<typeof AboutFacet>;

export const AboutResponse = z.object({
  overview: z.object({
    title: z.string(),
    bodyMd: z.string(),
  }),
  howItWorks: z.object({
    title: z.string(),
    bodyMd: z.string(),
  }),
  facets: z.array(AboutFacet),
  featuredProofs: z.array(PortfolioProof),
  featuredReferences: z.array(ExternalReference),
});
export type AboutResponse = z.infer<typeof AboutResponse>;

// --- GET /portfolio/proofs?agent=&tag=&featured= ----------------------------
export const ProofsResponse = z.object({
  proofs: z.array(PortfolioProof),
});
export type ProofsResponse = z.infer<typeof ProofsResponse>;

export const ProofResponse = z.object({
  proof: PortfolioProof,
});
export type ProofResponse = z.infer<typeof ProofResponse>;

// --- GET /references?q=&agent=&tag=&kind=  and  GET /references/:id ----------
export const ReferencesResponse = z.object({
  references: z.array(ExternalReference),
});
export type ReferencesResponse = z.infer<typeof ReferencesResponse>;

export const ReferenceResponse = z.object({
  reference: ExternalReference,
});
export type ReferenceResponse = z.infer<typeof ReferenceResponse>;
