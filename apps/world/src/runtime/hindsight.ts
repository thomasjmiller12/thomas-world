// Thin fetch wrapper over the self-hosted Hindsight HTTP API (plan §2 row 6,
// §4.2). One bank per agent, verbatim retain mode. We deliberately skip the
// generated SDK — it's a plain REST API and a fetch wrapper keeps the env-gating
// uniform with the rest of the runtime.
//
// API shape (verified live against ghcr.io/vectorize-io/hindsight:0.7.0-slim):
//   retain : POST /v1/default/banks/{bank}/memories   body {items:[{content,…}]}
//   recall : POST /v1/default/banks/{bank}/memories/recall  body {query,max_tokens}
//   delete : DELETE /v1/default/banks/{bank}/memories[?type=]  (bank/type-wide only —
//            Hindsight has NO single-memory delete; see forgetAll() below)
//   reflect: POST /v1/default/banks/{bank}/reflect    body {query}
//
// Env-gated: when HINDSIGHT is off (no URL / no OpenAI key for embeddings), every
// call returns a structured soft-failure and logs a one-time warning. No throws,
// no silent success (brief env-gating pattern).

import type { AgentId } from "@town/contract";
import { z } from "zod";
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
  reason?: "disabled" | "timeout" | "network" | "http" | "invalid_response" | "rejected";
  status?: number;
}

const SOFT_FAIL: HindsightResult = {
  ok: false,
  text: "Your long-term memory is hazy today — you can't quite reach those older recollections.",
};

type Operation = "remember" | "recall" | "reflect" | "forget" | "stats";
type FailureReason = NonNullable<HindsightResult["reason"]>;
export interface HindsightFailure {
  operation: Operation;
  reason: FailureReason;
  status?: number;
  at: string;
}
const lastFailures = new Map<AgentId, HindsightFailure>();
const lastWarnings = new Map<string, number>();
export const HINDSIGHT_TIMEOUT_MS = 30_000;

function failure(agentId: AgentId, operation: Operation, reason: FailureReason, status?: number): HindsightResult {
  const now = Date.now();
  const detail = { operation, reason, ...(status === undefined ? {} : { status }), at: new Date(now).toISOString() };
  lastFailures.set(agentId, detail);
  const key = `${agentId}:${operation}:${reason}`;
  if (now - (lastWarnings.get(key) ?? -Infinity) >= 60_000) {
    lastWarnings.set(key, now);
    // Never log response bodies, memory content, queries, URLs, or provider errors:
    // they may contain private visitor text or credentials. HTTP status is enough
    // to distinguish service/storage failures from an empty successful recall.
    console.warn("[hindsight] request failed", { agentId, ...detail });
  }
  return { ...SOFT_FAIL, reason, ...(status === undefined ? {} : { status }) };
}

type RequestResult = { ok: true; data: unknown } | { ok: false; failure: HindsightResult };

async function request(
  agentId: AgentId,
  operation: Operation,
  method: string,
  url: string,
  body?: unknown,
): Promise<RequestResult> {
  if (!config.features.hindsight) {
    return { ok: false, failure: failure(agentId, operation, "disabled") };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HINDSIGHT_TIMEOUT_MS);
  let readingBody = false;
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, failure: failure(agentId, operation, "http", res.status) };
    }
    readingBody = true;
    return { ok: true, data: res.status === 204 ? null : await res.json() };
  } catch {
    const reason = controller.signal.aborted ? "timeout" : readingBody ? "invalid_response" : "network";
    return { ok: false, failure: failure(agentId, operation, reason) };
  } finally {
    clearTimeout(timer);
  }
}

export interface RememberOptions {
  documentId?: string;
  observedAt?: string;
  metadata?: Record<string, string>;
}

// Verified against the running 0.7.0 OpenAPI contract. A queued operation is not
// the same as a synchronous stored memory; don't acknowledge it as "Stored".
const retainResponse = z.object({ success: z.boolean(), bank_id: z.string(), items_count: z.number().int(), async: z.boolean() });
const recallResponse = z.object({ results: z.array(z.object({ text: z.string() })) });

// Store a verbatim memory (the agent's exact words preserved). `kind` is a free
// tag the agent picks (e.g. "observation", "decision"); we keep it as both a
// searchable tag and string metadata. Synchronous ingest so a tick that
// remembers-then-recalls in the same scene sees its own write.
export async function remember(
  agentId: AgentId,
  content: string,
  kind: string,
  options: RememberOptions = {},
): Promise<HindsightResult> {
  const res = await request(agentId, "remember", "POST", bankUrl(agentId), {
    items: [
      {
        content,
        tags: [kind],
        metadata: { ...options.metadata, kind, agent: agentId },
        ...(options.documentId ? { document_id: options.documentId } : {}),
        ...(options.observedAt ? { timestamp: options.observedAt } : {}),
      },
    ],
    async: false,
  });
  if (!res.ok) return res.failure;
  const parsed = retainResponse.safeParse(res.data);
  if (!parsed.success) return failure(agentId, "remember", "invalid_response");
  const data = parsed.data;
  if (!data.success || data.async || data.bank_id !== bankFor(agentId) || data.items_count !== 1) {
    return failure(agentId, "remember", "rejected");
  }
  return { ok: true, text: "Stored." };
}

// Recall memories relevant to a query, bounded by maxTokens. Returns the joined
// verbatim text of the recalled memory units (RecallResponse.results[].text).
export async function recall(
  agentId: AgentId,
  query: string,
  maxTokens = 800,
  options: { tags?: string[] } = {},
): Promise<HindsightResult> {
  // In Hindsight 0.7, ordinary any/all ALSO include untagged memories. Automatic
  // public-evidence retrieval must use strict matching, never a private fallback.
  if (options.tags && (options.tags.length === 0 || options.tags.some((tag) => !tag.trim()))) {
    return failure(agentId, "recall", "rejected");
  }
  const res = await request(agentId, "recall", "POST", bankUrl(agentId, "/recall"), {
    query,
    max_tokens: maxTokens,
    ...(options.tags ? { tags: options.tags, tags_match: "all_strict" } : {}),
  });
  if (!res.ok) return res.failure;
  const parsed = recallResponse.safeParse(res.data);
  if (!parsed.success) return failure(agentId, "recall", "invalid_response");
  const lines = parsed.data.results.map((r) => r.text).filter(Boolean);
  return { ok: true, text: lines.length ? lines.join("\n---\n") : "(nothing relevant came to mind)" };
}

// NOTE: the model-facing `forget` tool (and this file's forget() behind it)
// was deleted 2026-07-30 — zero calls across the town's full recorded history.
// It was always a canned no-op acknowledgement anyway: Hindsight 0.7 exposes
// no per-memory delete, only a bank-wide (optionally type-filtered)
// destructive clear, so "forget this one thing" was never achievable — see
// forgetAll() below for the real (operator-only) bank clear.

// Destructive bank (or type) clear. Operator/test path only — never wired to a
// model-facing tool. `type` is one of Hindsight's: world | experience | opinion.
export async function forgetAll(
  agentId: AgentId,
  type?: "world" | "experience" | "opinion",
): Promise<HindsightResult> {
  const suffix = type ? `?type=${encodeURIComponent(type)}` : "";
  const res = await request(agentId, "forget", "DELETE", bankUrl(agentId, suffix));
  if (!res.ok) return res.failure;
  return { ok: true, text: "Cleared." };
}

// Synthesize an answer over stored memories. This is NOT consolidation and does
// not curate the town's core-memory files. A caller must actually use the answer.
export async function reflect(
  agentId: AgentId,
  query = "What stood out today, and what should I carry forward?",
): Promise<HindsightResult> {
  const res = await request(
    agentId,
    "reflect",
    "POST",
    `${config.hindsightUrl}/v1/default/banks/${bankFor(agentId)}/reflect`,
    { query },
  );
  if (!res.ok) return res.failure;
  const parsed = z.object({ text: z.string() }).safeParse(res.data);
  if (!parsed.success) return failure(agentId, "reflect", "invalid_response");
  return { ok: true, text: parsed.data.text };
}

const bankStatsResponse = z.object({
  total_nodes: z.number().int().nonnegative(),
  total_documents: z.number().int().nonnegative(),
  pending_operations: z.number().int().nonnegative(),
  failed_operations: z.number().int().nonnegative(),
});

// Read-only storage readiness, distinct from Hindsight's /health connectivity.
// lastFailure is process-local evidence and may predate a successful operation.
export async function memoryBankStats(agentId: AgentId) {
  const res = await request(agentId, "stats", "GET",
    `${config.hindsightUrl}/v1/default/banks/${bankFor(agentId)}/stats`);
  if (!res.ok) return { ...res.failure, lastFailure: lastFailures.get(agentId) };
  const parsed = bankStatsResponse.safeParse(res.data);
  if (!parsed.success) return { ...failure(agentId, "stats", "invalid_response"), lastFailure: lastFailures.get(agentId) };
  return { ok: true as const, stats: parsed.data, lastFailure: lastFailures.get(agentId) };
}
