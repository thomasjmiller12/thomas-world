import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  CreateContributionRequest, RespondToContributionInput,
  type AgentId, type ArtifactContribution, type ArtifactRevision, type ArtifactRevisionSummary,
} from "@town/contract";
import { db, schema } from "../db/client.js";
import { materializeEventRow, publishCommittedEvent } from "./events.js";

const { artifactContributions: contributions, contributionResponses: responses, artifactRevisions: revisions,
  artifacts, visitors, worldEvents } = schema;
const unresolved = ["pending", "accepted", "blocked"] as const;
export const CONTRIBUTIONS_PER_MINUTE = 3;
export const CONTRIBUTIONS_PER_DAY = 20;
export const MAX_PENDING_PER_VISITOR = 10;
export const MAX_PENDING_PER_ARTIFACT = 100;

export class ContributionError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429) { super(message); }
}

export function acceptsContributions(kind: string): boolean {
  return !["diary_entry", "daily_digest", "bulletin"].includes(kind);
}

async function toContribution(row: typeof contributions.$inferSelect, visitorId?: string): Promise<ArtifactContribution> {
  const history = await db.select().from(responses).where(eq(responses.contributionId, row.id))
    .orderBy(desc(responses.createdAt), desc(responses.id)).limit(10);
  return {
    id: row.id, artifactId: row.artifactId, agentId: row.agentId,
    contributorName: row.contributorName, text: row.text, status: row.status,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    mine: row.visitorId === visitorId,
    responses: history.reverse().map((r) => ({
      id: r.id, agentId: r.agentId, status: r.status, response: r.response,
      revisionId: r.revisionId, createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function createContribution(artifactId: string, input: unknown) {
  const parsed = CreateContributionRequest.safeParse(input);
  if (!parsed.success) throw new ContributionError("Write a suggestion between 1 and 2,000 characters.", 400);
  const { visitorId, requestId, text } = parsed.data;
  const result = await db.transaction(async (tx) => {
    // Serialize per visitor, including duplicate retries and quota checks across artifacts.
    const [visitor] = await tx.select().from(visitors).where(eq(visitors.id, visitorId)).for("update");
    if (!visitor) throw new ContributionError("Unknown visitor.", 404);
    const [prior] = await tx.select().from(contributions)
      .where(and(eq(contributions.visitorId, visitorId), eq(contributions.requestId, requestId)));
    if (prior) {
      if (prior.artifactId !== artifactId || prior.text !== text) {
        throw new ContributionError("That request was already used for a different suggestion.", 409);
      }
      return { row: prior, created: false, event: null };
    }
    // Also serialize the artifact-wide queue cap, even for different visitors.
    const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).for("update");
    if (!artifact) throw new ContributionError("This creation wasn't found.", 404);
    if (!acceptsContributions(artifact.kind)) throw new ContributionError("Suggestions are for creations in Made.", 400);
    const now = new Date();
    const recent = await tx.select({ createdAt: contributions.createdAt }).from(contributions)
      .where(and(eq(contributions.visitorId, visitorId), gte(contributions.createdAt, new Date(now.getTime() - 86_400_000))))
      .limit(CONTRIBUTIONS_PER_DAY);
    if (recent.length >= CONTRIBUTIONS_PER_DAY || recent.filter((r) => r.createdAt.getTime() > now.getTime() - 60_000).length >= CONTRIBUTIONS_PER_MINUTE) {
      throw new ContributionError("Give the residents time to read these. Try again later.", 429);
    }
    const pending = await tx.select({ id: contributions.id }).from(contributions)
      .where(and(eq(contributions.visitorId, visitorId), inArray(contributions.status, [...unresolved])))
      .limit(MAX_PENDING_PER_VISITOR);
    const artifactPending = await tx.select({ id: contributions.id }).from(contributions)
      .where(and(eq(contributions.artifactId, artifactId), inArray(contributions.status, [...unresolved])))
      .limit(MAX_PENDING_PER_ARTIFACT);
    if (pending.length >= MAX_PENDING_PER_VISITOR || artifactPending.length >= MAX_PENDING_PER_ARTIFACT) {
      throw new ContributionError("There are already several open suggestions. Let the residents work through them first.", 429);
    }
    const [row] = await tx.insert(contributions).values({
      id: randomUUID(), artifactId, agentId: artifact.agentId, visitorId, requestId,
      contributorName: visitor.name, text,
    }).returning();
    const [event] = await tx.insert(worldEvents).values({
      type: "artifact.contribution", agentId: artifact.agentId, locationId: artifact.locationId,
      visibility: "public", payload: { artifactId, contributionId: row.id, agent: artifact.agentId, status: "pending" },
    }).returning();
    return { row, created: true, event };
  });
  if (result.event) publishCommittedEvent(materializeEventRow(result.event));
  return { contribution: await toContribution(result.row, visitorId), created: result.created };
}

/** Untrusted visitor prose. Unanswered work must not hide behind old blockers. */
export async function pendingContributionsForAgent(agentId: AgentId) {
  const rows = await db.select({
    id: contributions.id, artifactId: contributions.artifactId, artifactTitle: artifacts.title,
    contributorName: contributions.contributorName, text: contributions.text,
    status: contributions.status, createdAt: contributions.createdAt,
  }).from(contributions).innerJoin(artifacts, eq(artifacts.id, contributions.artifactId))
    .where(and(eq(contributions.agentId, agentId), inArray(contributions.status, [...unresolved])))
    .orderBy(
      sql`case ${contributions.status} when 'pending' then 0 when 'accepted' then 1 else 2 end`,
      asc(contributions.updatedAt), asc(contributions.id),
    ).limit(10);
  return Promise.all(rows.map(async (r) => {
    const [latest] = await db.select({ response: responses.response }).from(responses)
      .where(eq(responses.contributionId, r.id)).orderBy(desc(responses.createdAt), desc(responses.id)).limit(1);
    return { ...r, response: latest?.response ?? null, createdAt: r.createdAt.toISOString() };
  }));
}

export async function respondToContribution(agentId: AgentId, input: unknown) {
  const parsed = RespondToContributionInput.safeParse(input);
  if (!parsed.success) throw new ContributionError("Choose a status and give a concrete response (1–2,000 characters).", 400);
  const { contributionId, status, response, revisionId } = parsed.data;
  if (status === "completed" && !revisionId) {
    throw new ContributionError("Complete a suggestion only with a saved revision explicitly credited to it.", 400);
  }
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(contributions).where(eq(contributions.id, contributionId)).for("update");
    if (!row) throw new ContributionError("No such contribution.", 404);
    if (row.agentId !== agentId) throw new ContributionError("Only the creation's owner can respond.", 403);
    if (revisionId) {
      const [revision] = await tx.select().from(revisions).where(eq(revisions.id, revisionId));
      if (!revision || revision.artifactId !== row.artifactId || revision.contributionId !== contributionId) {
        throw new ContributionError("The result must be a revision explicitly attributed to this contribution.", 400);
      }
    }
    const [latest] = await tx.select().from(responses).where(eq(responses.contributionId, contributionId))
      .orderBy(desc(responses.createdAt), desc(responses.id)).limit(1);
    // A replayed result is harmless even when it arrives outside one journaled turn.
    if (latest?.status === status && latest.response === response && latest.revisionId === (revisionId ?? null)) {
      return { row, event: null };
    }
    if (row.status === "completed" || row.status === "declined") {
      throw new ContributionError("This contribution is closed. Its response history is preserved.", 409);
    }
    await tx.insert(responses).values({ id: randomUUID(), contributionId, agentId, status, response, revisionId });
    const [updated] = await tx.update(contributions).set({ status, updatedAt: new Date() })
      .where(eq(contributions.id, contributionId)).returning();
    const [event] = await tx.insert(worldEvents).values({
      type: "artifact.contribution", agentId, visibility: "public",
      payload: { artifactId: row.artifactId, contributionId, agent: agentId, status },
    }).returning();
    return { row: updated, event };
  });
  if (result.event) publishCommittedEvent(materializeEventRow(result.event));
  return { contribution: await toContribution(result.row), changed: result.event !== null };
}

export function revisionSummary(row: typeof revisions.$inferSelect): ArtifactRevisionSummary {
  return { id: row.id, artifactId: row.artifactId, version: row.version, agentId: row.agentId,
    title: row.title, contributionId: row.contributionId, createdAt: row.createdAt.toISOString() };
}

export async function getArtifactRevision(artifactId: string, revisionId: string): Promise<ArtifactRevision | undefined> {
  const [row] = await db.select().from(revisions).where(and(eq(revisions.artifactId, artifactId), eq(revisions.id, revisionId)));
  return row ? { ...revisionSummary(row), body: row.body, published: row.published } : undefined;
}

export async function artifactRevisionForVersion(artifactId: string, version: number) {
  const [row] = await db.select().from(revisions).where(and(eq(revisions.artifactId, artifactId), eq(revisions.version, version)));
  return row ? revisionSummary(row) : undefined;
}

export async function artifactTrail(artifactId: string, visitorId?: string) {
  const [recent, mine, history] = await Promise.all([
    db.select().from(contributions).where(eq(contributions.artifactId, artifactId))
      .orderBy(desc(contributions.createdAt), desc(contributions.id)).limit(20),
    visitorId ? db.select().from(contributions).where(and(eq(contributions.artifactId, artifactId), eq(contributions.visitorId, visitorId)))
      .orderBy(desc(contributions.createdAt), desc(contributions.id)).limit(20) : [],
    db.select().from(revisions).where(eq(revisions.artifactId, artifactId)).orderBy(desc(revisions.version)).limit(20),
  ]);
  const materialized = new Map((await Promise.all([...new Map([...recent, ...mine].map((r) => [r.id, r])).values()]
    .map(async (row) => [row.id, await toContribution(row, visitorId)] as const))).map((r) => r));
  return { contributions: recent.map((r) => materialized.get(r.id)!), yours: mine.map((r) => materialized.get(r.id)!), revisions: history.map(revisionSummary) };
}
