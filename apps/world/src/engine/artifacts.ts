// Artifact CRUD — create + update ONLY (no delete; the world keeps what it
// makes). Each anchored to a location fixture where visitors find it (plan §6).

import { and, desc, eq, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentId, ArtifactKind, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { artifacts } = schema;
export type ArtifactRow = typeof artifacts.$inferSelect;

// Default in-world anchor for each artifact kind (plan §6 table).
const DEFAULT_ANCHOR: Record<ArtifactKind, { location: LocationId | null; fixture: string | null }> = {
  blog_post: { location: "cafe", fixture: "press" },
  project_log: { location: "workshop", fixture: "monitor" },
  research_note: { location: "library", fixture: "bookshelf" },
  bulletin: { location: "town", fixture: "notice board" },
  fun_list: { location: "park", fixture: "the dumb sign" },
  diary_entry: { location: null, fixture: null },
  daily_digest: { location: "town", fixture: "news stand" },
};

export interface CreateArtifactInput {
  agentId: AgentId;
  kind: ArtifactKind;
  title: string;
  body: string;
  location?: LocationId | null;
  fixture?: string | null;
  published?: boolean;
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRow> {
  const anchor = DEFAULT_ANCHOR[input.kind];
  const location = input.location !== undefined ? input.location : anchor.location;
  const fixture = input.fixture !== undefined ? input.fixture : anchor.fixture;
  const id = randomUUID();
  const [row] = await db
    .insert(artifacts)
    .values({
      id,
      agentId: input.agentId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      locationId: location,
      fixture,
      published: input.published ?? false,
    })
    .returning();

  // Bulletins get their own headline event (board surface); everything else
  // emits artifact.created.
  if (input.kind === "bulletin") {
    await appendEvent({
      type: "bulletin.posted",
      agentId: input.agentId,
      locationId: location,
      visibility: "public",
      payload: { artifactId: id, agent: input.agentId, title: input.title },
    });
  } else {
    await appendEvent({
      type: "artifact.created",
      agentId: input.agentId,
      locationId: location,
      visibility: "public",
      payload: {
        artifactId: id,
        agent: input.agentId,
        kind: input.kind,
        title: input.title,
        location,
        fixture,
      },
    });
  }
  return row;
}

export interface UpdateArtifactInput {
  title?: string;
  body?: string;
  published?: boolean;
}

export async function updateArtifact(
  id: string,
  patch: UpdateArtifactInput,
): Promise<ArtifactRow | undefined> {
  const [existing] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  if (!existing) return undefined;
  const [row] = await db
    .update(artifacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(artifacts.id, id))
    .returning();
  await appendEvent({
    type: "artifact.updated",
    agentId: row.agentId as AgentId,
    locationId: row.locationId as LocationId | null,
    visibility: "public",
    payload: {
      artifactId: row.id,
      agent: row.agentId,
      kind: row.kind,
      title: row.title,
      location: row.locationId,
      fixture: row.fixture,
    },
  });
  return row;
}

export async function getArtifact(id: string): Promise<ArtifactRow | undefined> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return row;
}

export async function listArtifacts(
  filters: { kind?: ArtifactKind; agent?: AgentId } = {},
  limit = 100,
): Promise<ArtifactRow[]> {
  const conds: SQL[] = [];
  if (filters.kind) conds.push(eq(artifacts.kind, filters.kind));
  if (filters.agent) conds.push(eq(artifacts.agentId, filters.agent));
  return db
    .select()
    .from(artifacts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(artifacts.createdAt))
    .limit(limit);
}
