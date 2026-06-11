// The "outside world" engine surface: capability requests and outbound email.
// Both are gated to the office outbox at the tool layer (plan §3.3); here we
// just persist + emit. Email sends via Resend when configured, else queues to
// the outbox table (brief env-gating: "queued-not-sent in-fiction").

import { randomUUID } from "node:crypto";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";
import { config } from "../config.js";

const { capabilityRequests, outbox } = schema;

export async function recordCapabilityRequest(
  agentId: AgentId,
  summary: string,
  rationale: string,
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insert(capabilityRequests).values({ id, agentId, summary, rationale });
  // capability.requested is public — it's the meta-layer flex surface (plan §5).
  await appendEvent({
    type: "capability.requested",
    agentId,
    visibility: "public",
    payload: { agent: agentId, summary },
  });
  return { id };
}

// Send (or queue) an email to Thomas. Returns the outbox row id, whether it
// actually sent, and (when sent) Resend's provider message id. When Resend is
// absent OR a send fails, the row stays "queued"/"failed" and the caller reports
// queued-not-sent in-fiction.
export async function sendEmailToThomas(
  agentId: AgentId,
  subject: string,
  body: string,
): Promise<{ id: string; sent: boolean; messageId?: string }> {
  const id = randomUUID();
  await db.insert(outbox).values({ id, agentId, subject, body, status: "queued" });

  if (!config.features.resend) {
    return { id, sent: false };
  }

  // Two separate failure domains. (1) The SEND: only a thrown fetch or a non-OK
  // response marks the row "failed". (2) The post-send STATUS UPDATE: if it
  // throws, the email already WENT OUT — we must NOT flip the row to "failed"
  // (that would invite a duplicate email on any future retry). We leave it
  // "queued" and log; a retry can reconcile by message id.
  let messageId: string | undefined;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Thomas's Town <onboarding@resend.dev>",
        // The only recipient email_thomas ever targets is Thomas's own Resend
        // account email (plan §9). RESEND_TO overrides for testing.
        to: [process.env.RESEND_TO ?? "delivered@resend.dev"],
        subject: `[${agentId}] ${subject}`,
        text: body,
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    messageId = data.id;
  } catch (err) {
    console.warn(`[outside] email send failed, left queued:`, (err as Error).message);
    await db.update(outbox).set({ status: "failed" }).where(eqId(id)).catch(() => {});
    return { id, sent: false };
  }

  // The send succeeded. Record it — but a DB error here must not undo the send.
  try {
    await db
      .update(outbox)
      .set({ status: "sent", sentAt: new Date() })
      .where(eqId(id));
  } catch (err) {
    console.warn(
      `[outside] email SENT but status update failed (left queued for reconcile):`,
      (err as Error).message,
    );
  }
  return { id, sent: true, messageId };
}

// tiny local helper to avoid importing eq at module top for one use
import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(outbox.id, id);
}
