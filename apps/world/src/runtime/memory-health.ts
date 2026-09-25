import { agentIds } from "@town/contract";
import { memoryBankStats } from "./hindsight.js";

// Public diagnostic counts only; never return memories, queries, or provider
// error bodies. Single-flight cache bounds service reads on this public route.
let cached: { expires: number; value: ReturnType<typeof fetchHealth> } | undefined;
async function fetchHealth() {
  const banks = await Promise.all(agentIds.map(async (id) => {
    const result = await memoryBankStats(id);
    return result.ok && result.stats ? {
      id, status: result.stats.total_nodes ? "ready" as const : "empty" as const,
      documents: result.stats.total_documents, memories: result.stats.total_nodes,
      pendingOperations: result.stats.pending_operations, failedOperations: result.stats.failed_operations,
    } : { id, status: "unavailable" as const, reason: result.reason };
  }));
  return {
    ok: banks.every((bank) => bank.status !== "unavailable"),
    ts: new Date().toISOString(), banks,
    note: "Stored memories establish ingestion, not useful agency or correctness of remembered claims.",
  };
}
export function memoryHealth() {
  if (!cached || cached.expires <= Date.now()) {
    cached = { expires: Date.now() + 60_000, value: fetchHealth() };
  }
  return cached.value;
}
