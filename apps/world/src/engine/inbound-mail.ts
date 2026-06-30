import { and, desc, eq, isNull } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { agentIds } from "@town/contract";
import { db, schema } from "../db/client.js";

const { inboundMail } = schema;

export type InboundMailRow = typeof inboundMail.$inferSelect;

const agentSet = new Set<string>(agentIds);

export interface IncomingMailInput {
  providerId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  text: string;
  html?: string | null;
  raw?: unknown;
  receivedAt?: Date;
}

export function routeAgentFromAddress(toAddress: string, subject?: string): AgentId | null {
  const local = toAddress.match(/^([^@<\s]+)/)?.[1]?.toLowerCase() ?? "";
  const candidate = local.replace(/^reply[+._-]/, "").split(/[+._-]/)[0];
  if (agentSet.has(candidate)) return candidate as AgentId;

  const subjectAgent = subject?.match(/^\s*\[([a-z]+)\]/i)?.[1]?.toLowerCase();
  if (subjectAgent && agentSet.has(subjectAgent)) return subjectAgent as AgentId;
  return null;
}

export async function recordInboundMail(input: IncomingMailInput): Promise<InboundMailRow> {
  const toAgent = routeAgentFromAddress(input.toAddress, input.subject);
  const [row] = await db
    .insert(inboundMail)
    .values({
      providerId: input.providerId,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      toAgent,
      subject: input.subject,
      text: input.text,
      html: input.html ?? null,
      raw: input.raw ?? {},
      receivedAt: input.receivedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: inboundMail.providerId,
      set: {
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        toAgent,
        subject: input.subject,
        text: input.text,
        html: input.html ?? null,
        raw: input.raw ?? {},
      },
    })
    .returning();
  return row;
}

export async function unreadInboundFor(agentId: AgentId): Promise<InboundMailRow[]> {
  return db
    .select()
    .from(inboundMail)
    .where(and(eq(inboundMail.toAgent, agentId), isNull(inboundMail.readAt)))
    .orderBy(desc(inboundMail.receivedAt))
    .limit(20);
}

export async function readInboundMail(agentId: AgentId, id: string): Promise<InboundMailRow | null> {
  const [row] = await db
    .select()
    .from(inboundMail)
    .where(and(eq(inboundMail.id, id), eq(inboundMail.toAgent, agentId)));
  if (!row) return null;
  await db.update(inboundMail).set({ readAt: new Date() }).where(eq(inboundMail.id, id));
  return row;
}

