// Thin fetch wrapper over the Hindsight HTTP API (plan §2 row 6, §4.2). One
// bank per agent, verbatim retain mode. We deliberately skip the generated SDK
// (the pattern Hindsight's flagship user converged on) — it's a plain HTTP API.
//
// Env-gated: when HINDSIGHT is off (no URL / no OpenAI key for embeddings), all
// three calls return a structured soft-failure and log a one-time warning. No
// throws, no silent success (brief env-gating pattern).

import type { AgentId } from "@town/contract";
import { config } from "../config.js";

// Bank id per agent. Hindsight scopes memory by a "bank"/namespace; we use the
// agent id directly so each facet has an isolated episodic store.
function bankFor(agentId: AgentId): string {
  return `town-${agentId}`;
}

export interface HindsightResult {
  ok: boolean;
  // Present on success (recall) or as the in-fiction soft-failure copy.
  text: string;
}

const SOFT_FAIL: HindsightResult = {
  ok: false,
  text: "Your long-term memory is hazy today — you can't quite reach those older recollections.",
};

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "[hindsight] episodic memory is off (HINDSIGHT_URL / OPENAI_API_KEY absent) — remember/recall/forget degrade in-fiction.",
  );
}

async function call(path: string, body: unknown): Promise<Response | null> {
  if (!config.features.hindsight) {
    warnOnce();
    return null;
  }
  try {
    return await fetch(`${config.hindsightUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[hindsight] request failed (${path}):`, (err as Error).message);
    return null;
  }
}

// Store a verbatim memory (the agent's exact words preserved). `kind` is a free
// tag the agent picks (e.g. "observation", "decision").
export async function remember(
  agentId: AgentId,
  content: string,
  kind: string,
): Promise<HindsightResult> {
  const res = await call("/v1/memories", {
    bank: bankFor(agentId),
    content,
    metadata: { kind, agent: agentId },
    // verbatim retain mode is set at the container level
    // (HINDSIGHT_API_RETAIN_EXTRACTION_MODE=verbatim).
  });
  if (!res || !res.ok) return SOFT_FAIL;
  return { ok: true, text: "Stored." };
}

// Recall memories relevant to a query, bounded by maxTokens.
export async function recall(
  agentId: AgentId,
  query: string,
  maxTokens = 800,
): Promise<HindsightResult> {
  const res = await call("/v1/recall", {
    bank: bankFor(agentId),
    query,
    max_tokens: maxTokens,
  });
  if (!res || !res.ok) return SOFT_FAIL;
  try {
    const data = (await res.json()) as { memories?: Array<{ content?: string }>; text?: string };
    if (typeof data.text === "string") return { ok: true, text: data.text };
    const lines = (data.memories ?? []).map((m) => m.content ?? "").filter(Boolean);
    return {
      ok: true,
      text: lines.length ? lines.join("\n---\n") : "(nothing relevant came to mind)",
    };
  } catch {
    return SOFT_FAIL;
  }
}

// Forget memories matching a query (or delete by id if the agent supplies one).
export async function forget(agentId: AgentId, query: string): Promise<HindsightResult> {
  const res = await call("/v1/memories/forget", {
    bank: bankFor(agentId),
    query,
  });
  if (!res || !res.ok) return SOFT_FAIL;
  return { ok: true, text: "Let that one go." };
}

// Nightly consolidation pass (plan §4.1 reflection). Best-effort; no-op when off.
export async function reflect(agentId: AgentId): Promise<HindsightResult> {
  const res = await call("/v1/reflect", { bank: bankFor(agentId) });
  if (!res || !res.ok) return SOFT_FAIL;
  return { ok: true, text: "Reflected." };
}
