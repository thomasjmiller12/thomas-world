// Thin fetch wrapper over the self-hosted Hindsight HTTP API (plan §2 row 6,
// §4.2). One bank per agent, verbatim retain mode. We deliberately skip the
// generated SDK — it's a plain REST API and a fetch wrapper keeps the env-gating
// uniform with the rest of the runtime.
//
// API shape (verified live against ghcr.io/vectorize-io/hindsight:0.7.0-slim):
//   retain : POST /v1/default/banks/{bank}/memories   body {items:[{content,…}]}
//   recall : POST /v1/default/banks/{bank}/memories/recall  body {query,max_tokens}
//   delete : DELETE /v1/default/banks/{bank}/memories[?type=]  (bank/type-wide only —
//            Hindsight has NO single-memory delete; see forget() below)
//   reflect: POST /v1/default/banks/{bank}/reflect    body {query}
//
// Env-gated: when HINDSIGHT is off (no URL / no OpenAI key for embeddings), every
// call returns a structured soft-failure and logs a one-time warning. No throws,
// no silent success (brief env-gating pattern).

import type { AgentId } from "@town/contract";
import { config } from "../config.js";

// Bank id per agent. Hindsight scopes memory by a bank; we use a `town-<agent>`
// namespace so each facet has an isolated episodic store.
function bankFor(agentId: AgentId): string {
  return `town-${agentId}`;
}

function bankUrl(agentId: AgentId, suffix = ""): string {
  return `${config.hindsightUrl}/v1/default/banks/${bankFor(agentId)}/memories${suffix}`;
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

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<Response | null> {
  if (!config.features.hindsight) {
    warnOnce();
    return null;
  }
  try {
    return await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[hindsight] ${method} ${url} failed:`, (err as Error).message);
    return null;
  }
}

// Store a verbatim memory (the agent's exact words preserved). `kind` is a free
// tag the agent picks (e.g. "observation", "decision"); we keep it as both a
// searchable tag and string metadata. Synchronous ingest so a tick that
// remembers-then-recalls in the same scene sees its own write.
export async function remember(
  agentId: AgentId,
  content: string,
  kind: string,
): Promise<HindsightResult> {
  const res = await request("POST", bankUrl(agentId), {
    items: [
      {
        content,
        tags: [kind],
        metadata: { kind, agent: agentId },
      },
    ],
    async: false,
  });
  if (!res || !res.ok) return SOFT_FAIL;
  try {
    const data = (await res.json()) as { success?: boolean };
    return data.success
      ? { ok: true, text: "Stored." }
      : SOFT_FAIL;
  } catch {
    return SOFT_FAIL;
  }
}

// Recall memories relevant to a query, bounded by maxTokens. Returns the joined
// verbatim text of the recalled memory units (RecallResponse.results[].text).
export async function recall(
  agentId: AgentId,
  query: string,
  maxTokens = 800,
): Promise<HindsightResult> {
  const res = await request("POST", bankUrl(agentId, "/recall"), {
    query,
    max_tokens: maxTokens,
  });
  if (!res || !res.ok) return SOFT_FAIL;
  try {
    const data = (await res.json()) as {
      results?: Array<{ text?: string }>;
    };
    const lines = (data.results ?? []).map((r) => r.text ?? "").filter(Boolean);
    return {
      ok: true,
      text: lines.length ? lines.join("\n---\n") : "(nothing relevant came to mind)",
    };
  } catch {
    return SOFT_FAIL;
  }
}

// "Let go" of memories. IMPORTANT: Hindsight 0.7 exposes no per-memory delete —
// only a bank-wide (optionally type-filtered) destructive clear. Pinpoint
// "forget this one thing" is therefore not achievable; rather than silently
// nuke the agent's whole episodic store on a stray tool call, we treat forget
// as a no-op acknowledgement in-fiction (the memory simply fades on its own).
// Bank/type-wide clears are an explicit operator action via forgetAll().
export async function forget(agentId: AgentId, _query: string): Promise<HindsightResult> {
  if (!config.features.hindsight) {
    warnOnce();
    return SOFT_FAIL;
  }
  void agentId;
  return {
    ok: true,
    text: "You let that one drift to the back of your mind — it'll fade on its own.",
  };
}

// Destructive bank (or type) clear. Operator/test path only — never wired to a
// model-facing tool. `type` is one of Hindsight's: world | experience | opinion.
export async function forgetAll(
  agentId: AgentId,
  type?: "world" | "experience" | "opinion",
): Promise<HindsightResult> {
  const suffix = type ? `?type=${encodeURIComponent(type)}` : "";
  const res = await request("DELETE", bankUrl(agentId, suffix));
  if (!res || !res.ok) return SOFT_FAIL;
  return { ok: true, text: "Cleared." };
}

// Nightly consolidation/synthesis pass (plan §4.1 reflection). Hindsight's
// reflect requires a focusing query; the nightly pass asks the bank to surface
// what mattered most that day. Best-effort; soft-fails when off.
export async function reflect(
  agentId: AgentId,
  query = "What stood out today, and what should I carry forward?",
): Promise<HindsightResult> {
  const res = await request(
    "POST",
    `${config.hindsightUrl}/v1/default/banks/${bankFor(agentId)}/reflect`,
    { query },
  );
  if (!res || !res.ok) return SOFT_FAIL;
  try {
    const data = (await res.json()) as { text?: string };
    return { ok: true, text: data.text ?? "Reflected." };
  } catch {
    return SOFT_FAIL;
  }
}
