// Artifact state (programmable world, D3): the per-artifact keyed JSON store —
// the "database" every interactive artifact gets for free. A Go board's
// position, a guestbook's entries, a poll's tallies all live here. Two writers:
// visitors (PUT /artifacts/:id/state/:key, rate-limited at the HTTP layer) and
// the owning agent (write_artifact_state tool). Every write emits
// artifact.state_changed carrying WHICH keys changed (never values — an open
// ArtifactFrame refetches; the event is an invalidation signal).
//
// Size discipline: keys ≤ 64 chars, one value ≤ 32KB serialized, ≤ 256 keys per
// artifact. Generous for turn-based games and guestbooks; enough to stop one
// artifact becoming a dumping ground.

import { and, eq, sql } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";

const { artifactState } = schema;

export const STATE_KEY_MAX = 64;
export const STATE_VALUE_MAX_BYTES = 32_768;
export const STATE_KEYS_MAX = 256;

export type StateWriter = { agent: AgentId } | { visitorId: string };

export async function getArtifactState(
  artifactId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(artifactState)
    .where(eq(artifactState.artifactId, artifactId));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Set (or, with value === null, delete) one key. Returns an in-fiction-friendly
// result rather than throwing so both the tool and the HTTP route can surface
// a graceful reason.
export async function setArtifactStateKey(
  artifactId: string,
  key: string,
  value: unknown,
  writer: StateWriter,
): Promise<{ ok: boolean; reason?: string }> {
  if (!key || key.length > STATE_KEY_MAX) return { ok: false, reason: "bad-key" };

  if (value === null || value === undefined) {
    await db
      .delete(artifactState)
      .where(and(eq(artifactState.artifactId, artifactId), eq(artifactState.key, key)));
  } else {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return { ok: false, reason: "not-json" };
    }
    if (serialized === undefined) return { ok: false, reason: "not-json" };
    if (Buffer.byteLength(serialized, "utf8") > STATE_VALUE_MAX_BYTES) {
      return { ok: false, reason: "too-big" };
    }
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(artifactState)
      .where(eq(artifactState.artifactId, artifactId));
    const [existing] = await db
      .select({ key: artifactState.key })
      .from(artifactState)
      .where(and(eq(artifactState.artifactId, artifactId), eq(artifactState.key, key)));
    if (!existing && Number(n) >= STATE_KEYS_MAX) return { ok: false, reason: "too-many-keys" };

    const updatedBy = "agent" in writer ? writer.agent : `visitor:${writer.visitorId}`;
    await db
      .insert(artifactState)
      .values({ artifactId, key, value, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [artifactState.artifactId, artifactState.key],
        set: { value, updatedBy, updatedAt: new Date() },
      });
  }

  await appendEvent({
    type: "artifact.state_changed",
    agentId: "agent" in writer ? writer.agent : null,
    visitorId: "visitorId" in writer ? writer.visitorId : null,
    visibility: "public",
    payload: {
      artifactId,
      keys: [key],
      agent: "agent" in writer ? writer.agent : null,
      visitorId: "visitorId" in writer ? writer.visitorId : null,
    },
  });
  return { ok: true };
}

// --- owner cue throttle -------------------------------------------------------
// A visitor writing state is a signal the owning agent should get a "your move"
// tick — but at most once per artifact per window, or a busy Go game would
// flood the queue with noted (uncoalesceable) ticks. Pure/in-memory; the HTTP
// layer calls this and does the actual enqueue.
const CUE_WINDOW_MS = 90_000;
const lastCue = new Map<string, number>();

export function shouldCueOwner(artifactId: string, now = Date.now()): boolean {
  const prev = lastCue.get(artifactId);
  if (prev !== undefined && now - prev < CUE_WINDOW_MS) return false;
  lastCue.set(artifactId, now);
  return true;
}

export function _resetCueThrottleForTest(): void {
  lastCue.clear();
}
