// Small durable working set, separate from identity and opaque native history.
// The reserved metadata row cannot be edited by the generic memory tool.
import * as z from "zod/v4";
import { and, eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { getArtifact } from "../engine/artifacts.js";
import { capabilityRequestsFor } from "../engine/outside.js";
import { defineTownTool, type TownToolInvocationContext } from "./llm/tool.js";

export const PURSUITS_PATH = "/.pursuits";
export const Pursuit = z.object({
  title: z.string().trim().min(1).max(120),
  why: z.string().trim().min(1).max(400),
  status: z.enum(["active", "blocked", "parked", "done"]),
  nextStep: z.string().max(400),
  blocker: z.string().max(400),
  evidence: z.string().max(600),
  artifactIds: z.array(z.string().min(1).max(100)).max(3),
  capabilityRequestIds: z.array(z.string().min(1).max(100)).max(3),
});
export const UpdatePursuits = z.object({ pursuits: z.array(Pursuit).max(3) });
const SavedPursuits = UpdatePursuits.extend({
  updatedAt: z.iso.datetime(),
  source: z.enum(["agent", "operator-reconciliation"]).default("agent"),
});
export type PursuitState = z.infer<typeof SavedPursuits>;

export async function loadPursuits(agentId: AgentId): Promise<PursuitState | null> {
  const [row] = await db.select().from(schema.memoryFiles).where(and(
    eq(schema.memoryFiles.agentId, agentId), eq(schema.memoryFiles.path, PURSUITS_PATH),
  ));
  if (!row) return null;
  // Do not quietly replace corrupt focus with an empty working set.
  return SavedPursuits.parse(JSON.parse(row.content));
}

export function buildPursuitTool(agentId: AgentId) {
  return defineTownTool({
    name: "update_pursuits",
    effect: "write",
    description: "Keep your current pursuits across days and compaction. Replaces your small working set (at most three, at most two active); include pursuits you are carrying forward. Choose things you actually care about. Record what happened, the next useful step, and a specific dependency if blocked. Use canonical artifact/request ids when available. This is private working memory, not a public accomplishment. Before removing an idea you want to keep, save it in a durable private note. Finished work stays in its artifact/history. Empty strings/arrays mean no evidence or dependency; never invent them.",
    inputSchema: UpdatePursuits,
    run: async (input, invocation) => {
      const { pursuits } = UpdatePursuits.parse(input);
      if (pursuits.filter((p) => p.status === "active").length > 2) {
        return "Choose at most two active pursuits; park the others until you want to resume them.";
      }
      for (const p of pursuits) {
        if ((p.status === "active" || p.status === "blocked") && !p.nextStep.trim()) {
          return `Give “${p.title}” a concrete next step or a condition for resuming it.`;
        }
        if (p.status === "blocked" && !p.blocker.trim()) {
          return `Name the actual dependency blocking “${p.title}”.`;
        }
        if (p.status === "done" && !p.evidence.trim()) {
          return `Record the actual result for “${p.title}” before marking it done.`;
        }
      }
      const artifactIds = [...new Set(pursuits.flatMap((p) => p.artifactIds))];
      const requestIds = [...new Set(pursuits.flatMap((p) => p.capabilityRequestIds))];
      const [artifacts, requests] = await Promise.all([
        Promise.all(artifactIds.map(getArtifact)),
        requestIds.length ? capabilityRequestsFor(agentId, 100) : [],
      ]);
      const missingArtifact = artifactIds.find((_, i) => !artifacts[i]);
      if (missingArtifact) return `No artifact ${missingArtifact}; look it up before linking it.`;
      const missingRequest = requestIds.find((id) => !requests.some((r) => r.id === id));
      if (missingRequest) return `No capability request ${missingRequest} belongs to you; check list_capability_requests.`;
      const updatedAt = new Date();
      const content = JSON.stringify({ updatedAt: updatedAt.toISOString(), source: "agent", pursuits });
      await db.insert(schema.memoryFiles).values({ agentId, path: PURSUITS_PATH, content, updatedAt })
        .onConflictDoUpdate({
          target: [schema.memoryFiles.agentId, schema.memoryFiles.path],
          set: { content, updatedAt },
        });
      (invocation as TownToolInvocationContext | undefined)?.markApplied?.();
      return `Current pursuits saved at ${updatedAt.toISOString()}. They will be available tomorrow and after compaction. This records your plan; it does not complete the work.`;
    },
  });
}

export async function renderPursuits(agentId: AgentId, now = new Date()): Promise<string> {
  let state: PursuitState | null;
  try { state = await loadPursuits(agentId); }
  catch (error) {
    console.warn(`[pursuits ${agentId}] invalid stored focus:`, error instanceof SyntaxError ? "invalid JSON" : "schema mismatch");
    return "Your saved pursuits could not be read. Use update_pursuits to repair them after inspecting your work; do not assume they were completed.";
  }
  if (!state || state.pursuits.length === 0) {
    return "No current pursuit recorded. You may choose something you care about from your existing creations, an unanswered contribution, or a new idea. Inspect the actual state, then use update_pursuits to carry a next step across days. Quiet is allowed; no quota.";
  }
  const ids = [...new Set(state.pursuits.flatMap((p) => p.artifactIds))];
  const [artifacts, requests] = await Promise.all([
    Promise.all(ids.map(getArtifact)), capabilityRequestsFor(agentId, 100),
  ]);
  const lines = [
    `Your working set was edited ${state.updatedAt}. These are remembered intentions, not proof of current world state.`,
    ...(state.source === "operator-reconciliation" ? ["Thomas's project repair reconstructed these starting points from your existing work. They are suggestions you can revise, not choices you already made or an output quota."] : []),
    `Linked world records checked now (${now.toISOString()}):`,
  ];
  for (const p of state.pursuits) {
    lines.push(`### ${p.title} — ${p.status}`, `Why: ${p.why}`, `Next: ${p.nextStep || "none recorded"}`,
      `Dependency: ${p.blocker || "none recorded"}`, `Remembered evidence: ${p.evidence || "none recorded"}`);
    for (const id of p.artifactIds) {
      const a = artifacts[ids.indexOf(id)];
      lines.push(a
        ? `Live artifact ${id}: “${a.title}”, by ${a.agentId}, ${a.kind}, version ${a.version}, ${a.published ? "published" : "not published"}, updated ${a.updatedAt.toISOString()}. Read it to verify what is actually delivered.`
        : `Linked artifact ${id} is missing; review this pursuit.`);
    }
    for (const id of p.capabilityRequestIds) {
      const r = requests.find((request) => request.id === id);
      lines.push(r ? `Live request ${id}: ${r.status} — ${r.summary.slice(0, 350)}` : `Request ${id} could not be verified in your request history.`);
    }
  }
  if (now.getTime() - Date.parse(state.updatedAt) > 3 * 86_400_000) {
    lines.push("This working set has not been reviewed for more than three days. Check an old blocker before carrying it forward; park or finish work explicitly when its state changes.");
  }
  lines.push("Read linked work before deciding it is still blocked. Keep identity/relationships in core memory and dormant ideas in private notes. Update this working set when something actually changes.");
  return lines.join("\n");
}
