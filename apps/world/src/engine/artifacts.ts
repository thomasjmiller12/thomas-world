// Artifact CRUD — create + update ONLY (no delete; the world keeps what it
// makes). Each anchored to a location fixture where visitors find it (plan §6).

import { and, desc, eq, gt, notInArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentId, ArtifactKind, LocationId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent, materializeEventRow, publishCommittedEvent } from "./events.js";
import { ContributionError } from "./contributions.js";
import { attachArtifact, findObjectAtLocation } from "./objects.js";

const { artifacts, artifactRevisions, artifactContributions, worldEvents } = schema;
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
  // Programmable-world kinds live where they're MOUNTED (attachArtifact), not
  // at a per-kind home fixture.
  interactive: { location: null, fixture: null },
  shared_page: { location: null, fixture: null },
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

  // A fixture anchor is physical world state, not just descriptive metadata.
  // Resolve the seeded/canonical object behind the free-string fixture name and
  // use the normal attachment path so both sides of the relationship and the
  // renderer's object.attached cue stay in sync. Some callers intentionally
  // create unanchored artifacts, and a custom fixture may not exist, so absence
  // is a graceful metadata-only fallback.
  if (location && fixture) {
    const object = await findObjectAtLocation(location, fixture);
    if (object) await attachArtifact(object.id, id, input.agentId);
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
  attribution?: { agentId: AgentId; contributionId?: string },
): Promise<ArtifactRow | undefined> {
  const result = await db.transaction(async (tx) => {
    // One artifact lock orders versions and preserves the exact preceding content.
    const [existing] = await tx.select().from(artifacts).where(eq(artifacts.id, id)).for("update");
    if (!existing) return undefined;
    if (attribution && existing.agentId !== attribution.agentId) {
      throw new ContributionError("Only the owner may revise this creation.", 403);
    }
    if (attribution?.contributionId) {
      const [contribution] = await tx.select().from(artifactContributions)
        .where(eq(artifactContributions.id, attribution.contributionId)).for("update");
      if (!contribution || contribution.artifactId !== id || contribution.agentId !== attribution.agentId) {
        throw new ContributionError("That contribution does not belong to this creation and its owner.", 400);
      }
      if (contribution.status === "completed" || contribution.status === "declined") {
        throw new ContributionError("That contribution is closed.", 409);
      }
    }
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const published = patch.published ?? existing.published;
    if (title === existing.title && body === existing.body && published === existing.published) {
      if (attribution?.contributionId) throw new ContributionError("No content changed; a contribution cannot be credited with an unchanged revision.", 400);
      return { row: existing, event: null };
    }
    const now = new Date();
    const snapshot = { artifactId: id, agentId: existing.agentId, title: existing.title,
      body: existing.body, published: existing.published, version: existing.version };
    // Existing artifacts predate history. Capture their current version once,
    // without attributing it to the new visitor suggestion.
    await tx.insert(artifactRevisions).values({ id: randomUUID(), ...snapshot, createdAt: existing.updatedAt })
      .onConflictDoNothing({ target: [artifactRevisions.artifactId, artifactRevisions.version] });
    await tx.insert(artifactRevisions).values({
      ...snapshot, id: randomUUID(), version: existing.version + 1, title, body, published,
      contributionId: attribution?.contributionId, createdAt: now,
    });
    const [row] = await tx.update(artifacts).set({ title, body, published, version: existing.version + 1, updatedAt: now })
      .where(eq(artifacts.id, id)).returning();
    const [event] = await tx.insert(worldEvents).values({
      type: "artifact.updated", agentId: row.agentId, locationId: row.locationId,
      visibility: "public", payload: { artifactId: row.id, agent: row.agentId,
        kind: row.kind, title: row.title, location: row.locationId, fixture: row.fixture },
    }).returning();
    return { row, event };
  });
  if (result?.event) publishCommittedEvent(materializeEventRow(result.event));
  return result?.row;
}

export async function getArtifact(id: string): Promise<ArtifactRow | undefined> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return row;
}

export async function listArtifacts(
  filters: { kind?: ArtifactKind; agent?: AgentId; scope?: "all" | "made" } = {},
  limit = 100,
  page: { offset?: number; order?: "updated" } = {},
): Promise<ArtifactRow[]> {
  const conds: SQL[] = [];
  if (filters.kind) conds.push(eq(artifacts.kind, filters.kind));
  if (filters.agent) conds.push(eq(artifacts.agentId, filters.agent));
  if (filters.scope === "made") conds.push(notInArray(artifacts.kind, ["diary_entry", "bulletin"]));
  // Apply the display scope before LIMIT so nightly diaries cannot bury apps.
  const order = page.order === "updated"
    ? [desc(artifacts.updatedAt), desc(artifacts.id)]
    : filters.scope === "made"
      ? [sql`case when ${artifacts.kind} = 'interactive' then 0 else 1 end`, desc(artifacts.updatedAt), desc(artifacts.id)]
      : [desc(artifacts.createdAt), desc(artifacts.id)];
  return db
    .select()
    .from(artifacts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order)
    .limit(limit)
    .offset(page.offset ?? 0);
}

// Artifacts this agent made in the last `hours`, excluding diary entries
// (reflection writes those directly). Backs two guards: the create_artifact
// making-discipline pushback (a flood of new artifacts reads as spam, not life)
// and the reflection idempotency check (one diary per night, DB-grounded so
// restarts/retries can't double-write).
export async function recentArtifactsBy(
  agentId: AgentId,
  hours: number,
  kind?: ArtifactKind,
): Promise<ArtifactRow[]> {
  const cutoff = new Date(Date.now() - hours * 60 * 60_000);
  const conds: SQL[] = [eq(artifacts.agentId, agentId), gt(artifacts.createdAt, cutoff)];
  if (kind) conds.push(eq(artifacts.kind, kind));
  return db
    .select()
    .from(artifacts)
    .where(and(...conds))
    .orderBy(desc(artifacts.createdAt));
}
