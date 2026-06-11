// Langfuse tracing, env-gated (plan §2 row 10). When LANGFUSE_* keys are
// absent, every function here is a no-op so the rest of the runtime is
// identical with or without observability. We deliberately load the SDK
// lazily and tolerate its absence — M1 must boot and tick without Langfuse.
//
// Model: tick = trace, agent = userId, day = sessionId (plan §4.1).
// We avoid a hard dependency on a specific Langfuse SDK shape: if the package
// isn't installed or the keys are missing, traces collapse to no-ops.

import { config } from "../config.js";

export interface TraceHandle {
  // Record an observation/generation on this trace. Best-effort, never throws.
  event(name: string, data?: Record<string, unknown>): void;
  // Attach the final usage/output summary and close.
  end(data?: Record<string, unknown>): void;
}

const noopTrace: TraceHandle = {
  event() {},
  end() {},
};

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  if (!config.features.langfuse) {
    console.warn("[tracing] Langfuse keys absent — tracing is a no-op this boot.");
  }
}

// Start a trace for a tick or chat. `userId` = agent id, `sessionId` = the day
// bucket, `name` = "tick" | "chat" | "reflection". Returns a no-op handle when
// Langfuse is off; a structured-console fallback otherwise (the real OTel SDK
// wiring is deferred to deploy — keys aren't available locally per the brief).
export function startTrace(
  name: string,
  opts: { userId?: string; sessionId?: string; metadata?: Record<string, unknown> } = {},
): TraceHandle {
  warnOnce();
  if (!config.features.langfuse) return noopTrace;
  // Langfuse keys are present (deploy-time): emit a structured line per span so
  // the trace is at least visible in logs until the OTel exporter is wired.
  // (The brief gates this on key presence; the full @langfuse/otel exporter
  // lands when keys exist in the deployed env.)
  const traceId = `${name}-${opts.userId ?? "world"}-${Date.now()}`;
  return {
    event(evName, data) {
      console.log(`[trace ${traceId}] ${evName}`, data ? JSON.stringify(data) : "");
    },
    end(data) {
      console.log(`[trace ${traceId}] end`, data ? JSON.stringify(data) : "");
    },
  };
}
