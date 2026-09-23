import { z } from "zod";
import { AgentId } from "./ids.js";

export const ContributionStatus = z.enum(["pending", "accepted", "blocked", "completed", "declined"]);
export type ContributionStatus = z.infer<typeof ContributionStatus>;
export const MAX_CONTRIBUTION_LENGTH = 2_000;
export const MAX_CONTRIBUTION_RESPONSE_LENGTH = 2_000;

// Only this dedicated, explicitly public form creates a contribution. Chat is private.
export const CreateContributionRequest = z.object({
  visitorId: z.string().uuid(),
  requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_CONTRIBUTION_LENGTH),
}).strict();

export const RespondToContributionInput = z.object({
  contributionId: z.string().uuid(),
  status: ContributionStatus.exclude(["pending"]),
  response: z.string().trim().min(1).max(MAX_CONTRIBUTION_RESPONSE_LENGTH),
  revisionId: z.string().uuid().optional(),
}).strict();

export const ContributionResponse = z.object({
  id: z.string(),
  agentId: AgentId,
  status: ContributionStatus,
  response: z.string(),
  revisionId: z.string().nullable(),
  createdAt: z.string(),
});
export type ContributionResponse = z.infer<typeof ContributionResponse>;

export const ArtifactContribution = z.object({
  id: z.string(),
  artifactId: z.string(),
  agentId: AgentId,
  contributorName: z.string(),
  text: z.string(),
  status: ContributionStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  mine: z.boolean(),
  responses: z.array(ContributionResponse),
});
export type ArtifactContribution = z.infer<typeof ArtifactContribution>;

export const ArtifactRevisionSummary = z.object({
  id: z.string(),
  artifactId: z.string(),
  version: z.number().int().positive(),
  agentId: AgentId,
  title: z.string(),
  contributionId: z.string().nullable(),
  createdAt: z.string(),
});
export type ArtifactRevisionSummary = z.infer<typeof ArtifactRevisionSummary>;
export const ArtifactRevision = ArtifactRevisionSummary.extend({ body: z.string(), published: z.boolean() });
export type ArtifactRevision = z.infer<typeof ArtifactRevision>;

export const ArtifactTrailResponse = z.object({
  contributions: z.array(ArtifactContribution),
  // Separate query so a returning visitor's own contribution survives a busy public list.
  yours: z.array(ArtifactContribution),
  revisions: z.array(ArtifactRevisionSummary),
});
export type ArtifactTrailResponse = z.infer<typeof ArtifactTrailResponse>;
export const CreateContributionResponse = z.object({ contribution: ArtifactContribution, created: z.boolean() });
export const ArtifactRevisionResponse = z.object({ revision: ArtifactRevision });
