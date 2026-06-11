// Langfuse tracing via the OpenTelemetry SDK (plan §2 row 10). When the
// LANGFUSE_* keys are absent, every function here is a strict no-op so the rest
// of the runtime is byte-identical with or without observability (brief).
//
// Model (plan §4.1): tick = trace, agent = userId, day = sessionId, soul git
// hash = trace metadata. We use the v5 SDK (@langfuse/otel + @langfuse/tracing)
// with MANUAL spans — we deliberately skip OpenInference Anthropic
// auto-instrumentation: the SDK's toolRunner makes its own HTTP calls and we
// already own the round loop in tick.ts, so a hand-placed root span per tick
// (plus per-round events) gives a cleaner trace than auto-generated generation
// spans that don't know about ticks. Decision recorded in apps/world/README.md.
//
// Init/flush are explicit (initTracing at boot, shutdownTracing on SIGTERM) so
// spans are flushed before the process exits — OTel batches by default.

import { config } from "../config.js";

export interface TraceHandle {
  // Record an observation/event on this trace. Best-effort, never throws.
  event(name: string, data?: Record<string, unknown>): void;
  // Attach the final output summary and close the trace.
  end(data?: Record<string, unknown>): void;
  // The Langfuse trace id (for log correlation / verification). Empty when off.
  traceId: string;
}

const noopTrace: TraceHandle = {
  event() {},
  end() {},
  traceId: "",
};

// Lazily-required SDK pieces (kept off the hot path / out of the no-op build).
// Loaded once in initTracing so the imports never run when Langfuse is off.
let processor: { forceFlush: () => Promise<void>; shutdown: () => Promise<void> } | null = null;
let sdkStarted = false;
type TracingApi = typeof import("@langfuse/tracing");
let api: TracingApi | null = null;

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  if (!config.features.langfuse) {
    console.warn("[tracing] Langfuse keys absent — tracing is a no-op this boot.");
  }
}

// Start the OTel SDK + Langfuse span processor. Idempotent; no-op when off.
// Must run before any traced code (we call it first in main()).
export async function initTracing(): Promise<void> {
  if (sdkStarted) return;
  if (!config.features.langfuse) {
    warnOnce();
    return;
  }
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  api = await import("@langfuse/tracing");

  const proc = new LangfuseSpanProcessor({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
    environment: config.nodeEnv,
  });
  processor = proc;
  const sdk = new NodeSDK({ spanProcessors: [proc] });
  sdk.start();
  sdkStarted = true;
  console.log("[tracing] Langfuse OTel exporter started.");
}

// Force-flush buffered spans without shutting down. Used by the /admin/tick
// endpoint so a smoke test can verify the trace landed immediately (OTel batches
// by default). No-op when Langfuse is off.
export async function flushTracing(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
  } catch (err) {
    console.warn("[tracing] forceFlush failed:", (err as Error).message);
  }
}

// Flush + shutdown the exporter so no spans are lost on process exit.
export async function shutdownTracing(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
    await processor.shutdown();
  } catch (err) {
    console.warn("[tracing] flush/shutdown failed:", (err as Error).message);
  }
}

// Start a trace for a tick/chat/reflection. `userId` = agent id, `sessionId` =
// the day bucket, `name` = "tick" | "chat" | "reflection". Returns a no-op
// handle when Langfuse is off; otherwise a real root span that IS the trace,
// with trace-level userId/sessionId/metadata set via the Langfuse OTel keys.
export function startTrace(
  name: string,
  opts: { userId?: string; sessionId?: string; metadata?: Record<string, unknown> } = {},
): TraceHandle {
  warnOnce();
  if (!config.features.langfuse || !api) return noopTrace;

  try {
    const { startObservation, LangfuseOtelSpanAttributes } = api;
    const root = startObservation(name, { input: opts.metadata });
    const span = root.otelSpan;
    // Trace-level attributes (plan §4.1): name, userId, sessionId, metadata.
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, name);
    if (opts.userId) span.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, opts.userId);
    if (opts.sessionId)
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, opts.sessionId);
    if (opts.metadata)
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_METADATA,
        JSON.stringify(opts.metadata),
      );

    const traceId = span.spanContext().traceId;
    return {
      traceId,
      event(evName, data) {
        try {
          // Point-in-time child observation (auto-ended) for per-round detail.
          root.startObservation(evName, { metadata: data }, { asType: "event" });
        } catch {
          /* never break a tick on a tracing error */
        }
      },
      end(data) {
        try {
          if (data) root.update({ output: data });
          root.end();
        } catch {
          /* swallow */
        }
      },
    };
  } catch (err) {
    console.warn("[tracing] startTrace failed, degrading to no-op:", (err as Error).message);
    return noopTrace;
  }
}
