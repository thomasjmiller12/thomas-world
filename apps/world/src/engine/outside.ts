// The "outside world" engine surface: capability requests and outbound email.
// Both are gated to the office outbox at the tool layer (plan §3.3). Email sends
// via Resend when configured, else queues to the outbox table (brief env-gating:
// "queued-not-sent in-fiction"). A capability request persists, emits its public
// event AND emails Thomas — see recordCapabilityRequest for why the email is not
// optional.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import { appendEvent } from "./events.js";
import { config } from "../config.js";

const { capabilityRequests, outbox } = schema;

const agentNames: Record<AgentId, string> = {
  career: "Career Thomas",
  researcher: "Researcher Thomas",
  builder: "Builder Thomas",
  writer: "Writer Thomas",
  hobby: "Hobby Thomas",
};

function senderFor(agentId: AgentId): string {
  if (process.env.RESEND_FROM) return process.env.RESEND_FROM;
  const domain = config.resendAgentDomain;
  if (!domain) return "Thomas's Town <onboarding@resend.dev>";
  return `${agentNames[agentId]} <${agentId}@${domain}>`;
}

// A capability request that is OPEN — i.e. Thomas hasn't acted on it yet.
export interface OpenCapabilityRequest {
  id: string;
  agentId: AgentId;
  summary: string;
  ts: Date;
}

// What the agent is told after filing. Pure, because this string is the entire
// feedback loop: the old one asserted "Thomas will see it" when nothing emailed
// and nothing read the table, and agents re-filed asks they'd already made
// because no answer ever came back. It has to be honest about delivery AND name
// the backlog. `alreadyOpen` is the agent's OTHER open requests (before this one).
export function formatCapabilityReceipt(opts: {
  id: string;
  description: string;
  emailed: boolean;
  alreadyOpen: { summary: string }[];
}): string {
  const headline = firstLine(opts.description, 120);
  const delivery = opts.emailed
    ? "It's recorded and the email just went out to Thomas."
    : "It's recorded and queued for Thomas — the mail line is down right now, so it'll go out when it's back.";
  const backlog = opts.alreadyOpen.length
    ? `\n\nStill open from you, no answer yet — don't re-file these:\n${opts.alreadyOpen
        .map((r) => `- ${firstLine(r.summary, 110)}`)
        .join("\n")}`
    : "";
  return `Filed your capability request (id ${opts.id}): "${headline}". ${delivery}${backlog}`;
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0].trim();
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

// Every capability request still awaiting a decision, oldest first.
export async function openCapabilityRequests(
  agentId?: AgentId,
): Promise<OpenCapabilityRequest[]> {
  const where = agentId
    ? and(eq(capabilityRequests.status, "open"), eq(capabilityRequests.agentId, agentId))
    : eq(capabilityRequests.status, "open");
  const rows = await db
    .select({
      id: capabilityRequests.id,
      agentId: capabilityRequests.agentId,
      summary: capabilityRequests.summary,
      ts: capabilityRequests.ts,
    })
    .from(capabilityRequests)
    .where(where)
    .orderBy(capabilityRequests.ts);
  return rows as OpenCapabilityRequest[];
}

// FILE A CAPABILITY REQUEST — AND ACTUALLY TELL THOMAS (2026-08-02).
//
// This used to insert a row and emit a public event, full stop. There was no
// email, no read endpoint, and nothing anywhere writes the `status` column — so
// a request was write-only. Nine of them accumulated between 2026-06-12 and
// 2026-08-02, all still "open", none ever seen unless Thomas happened to be
// watching the live feed the second the event went by. Meanwhile the tool told
// the agent "Thomas will see it," which simply wasn't true.
//
// The dead end also caused duplicates: with no acknowledgement, an agent can't
// distinguish a filed request from an unfiled one, so it re-files. Builder asked
// for a Python sandbox on 2026-06-14 and again on 2026-08-02; Hobby filed two
// overlapping fixture-verb requests 42 minutes apart on 2026-07-01.
//
// The email is best-effort and deliberately AFTER the insert: a mail failure
// must never lose the request. `emailed` is returned so the tool can tell the
// agent what actually happened instead of asserting.
export async function recordCapabilityRequest(
  agentId: AgentId,
  summary: string,
  rationale: string,
): Promise<{ id: string; emailed: boolean }> {
  const id = randomUUID();
  await db.insert(capabilityRequests).values({ id, agentId, summary, rationale });
  // capability.requested is public — it's the meta-layer flex surface (plan §5).
  await appendEvent({
    type: "capability.requested",
    agentId,
    visibility: "public",
    payload: { agent: agentId, summary },
  });

  let emailed = false;
  try {
    const subject = `Capability request: ${summary.split("\n")[0].slice(0, 120)}`;
    const body = `${agentNames[agentId]} filed a capability request from the office outbox.\n\nWHAT THEY WANT\n${summary}\n\nWHY\n${rationale}\n\n— request id ${id}`;
    const r = await sendEmailToThomas(agentId, subject, body);
    emailed = r.sent;
  } catch (err) {
    console.warn(
      `[outside] capability request ${id} recorded but the email failed:`,
      (err as Error).message,
    );
  }
  return { id, emailed };
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
        from: senderFor(agentId),
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

function eqId(id: string) {
  return eq(outbox.id, id);
}
