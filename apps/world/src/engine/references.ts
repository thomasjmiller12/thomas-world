// External reference catalog (M2.2 — Part 3). Curated, Thomas-owned public
// references (projects / repos / demos / writing / resume) agents can share as
// cards. The catalog is an ALLOWLIST: only `public` rows are shareable, and the
// share tools resolve ids — never raw URLs — so a visitor can't coax an
// arbitrary link out of an agent. Seeded from curated data at deploy.

import { and, desc, asc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { AgentId, ExternalReference, ExternalReferenceKind } from "@town/contract";
import { db, schema } from "../db/client.js";

const { externalReferences } = schema;
type Row = typeof externalReferences.$inferSelect;

export function rowToReference(r: Row): ExternalReference {
  return {
    id: r.id,
    kind: r.kind as ExternalReferenceKind,
    title: r.title,
    shortTitle: r.shortTitle ?? null,
    summary: r.summary,
    bodyMd: r.bodyMd ?? null,
    url: r.url ?? null,
    githubUrl: r.githubUrl ?? null,
    liveUrl: r.liveUrl ?? null,
    imageUrl: r.imageUrl ?? null,
    agentIds: (r.agentIds ?? []) as AgentId[],
    tags: (r.tags ?? []) as string[],
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface ReferenceFilters {
  q?: string | null;
  agent?: AgentId | null;
  tag?: string | null;
  kind?: ExternalReferenceKind | null;
  // include non-public rows (admin only — never on visitor-facing paths)
  includePrivate?: boolean;
}

// List references (public by default), most-featured/most-recent first. Used by
// the About hub, the /references endpoint, and the share-tool search.
export async function listReferences(
  filters: ReferenceFilters = {},
  limit = 60,
): Promise<ExternalReference[]> {
  const conds: SQL[] = [];
  if (!filters.includePrivate) conds.push(eq(externalReferences.public, true));
  if (filters.kind) conds.push(eq(externalReferences.kind, filters.kind));
  if (filters.agent) {
    conds.push(sql`${externalReferences.agentIds} @> ${JSON.stringify([filters.agent])}::jsonb`);
  }
  if (filters.tag) {
    conds.push(sql`${externalReferences.tags} @> ${JSON.stringify([filters.tag])}::jsonb`);
  }
  if (filters.q) {
    const like = `%${filters.q}%`;
    conds.push(
      or(
        ilike(externalReferences.title, like),
        ilike(externalReferences.summary, like),
        ilike(externalReferences.shortTitle, like),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(externalReferences)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      desc(externalReferences.featured),
      asc(externalReferences.sortOrder),
      desc(externalReferences.updatedAt),
    )
    .limit(limit);
  return rows.map(rowToReference);
}

export async function getReference(id: string): Promise<ExternalReference | null> {
  const [r] = await db.select().from(externalReferences).where(eq(externalReferences.id, id));
  return r ? rowToReference(r) : null;
}

// Raw row (carries `public` + sourcePath) — the share tools check `public`
// before building a card.
export async function getReferenceRow(id: string): Promise<Row | null> {
  const [r] = await db.select().from(externalReferences).where(eq(externalReferences.id, id));
  return r ?? null;
}

export async function featuredReferences(limit = 6): Promise<ExternalReference[]> {
  const rows = await db
    .select()
    .from(externalReferences)
    .where(and(eq(externalReferences.public, true), eq(externalReferences.featured, true)))
    .orderBy(asc(externalReferences.sortOrder), desc(externalReferences.updatedAt))
    .limit(limit);
  return rows.map(rowToReference);
}

export interface UpsertReferenceInput {
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
  sourcePath?: string | null;
  sortOrder?: number;
  featured?: boolean;
}

// Idempotent upsert (seed path). Overwrites curated fields on conflict so the
// seed is the source of truth, but never deletes rows not in the seed.
export async function upsertReference(input: UpsertReferenceInput): Promise<void> {
  const values = {
    id: input.id,
    kind: input.kind,
    title: input.title,
    shortTitle: input.shortTitle ?? null,
    summary: input.summary,
    bodyMd: input.bodyMd ?? null,
    url: input.url ?? null,
    githubUrl: input.githubUrl ?? null,
    liveUrl: input.liveUrl ?? null,
    imageUrl: input.imageUrl ?? null,
    agentIds: input.agentIds ?? [],
    tags: input.tags ?? [],
    public: input.public ?? true,
    sourcePath: input.sourcePath ?? null,
    sortOrder: input.sortOrder ?? 0,
    featured: input.featured ?? false,
    updatedAt: new Date(),
  };
  await db
    .insert(externalReferences)
    .values(values)
    .onConflictDoUpdate({ target: externalReferences.id, set: { ...values } });
}
