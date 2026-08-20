import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import {
  materializeEventRow,
  publishCommittedEvent,
  type AppendEventInput,
} from "../engine/events.js";
import type {
  ToolResult,
  TownFunctionTool,
  TownTool,
  TownToolInvocationContext,
} from "./llm/tool.js";
import { buildAgentActedEvent } from "./action-event.js";

const { agentActionJournal, worldEvents } = schema;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function actionIdentity(input: {
  turnId: string;
  agentId: AgentId;
  toolName: string;
  args: unknown;
}): { id: string; inputHash: string } {
  const inputHash = createHash("sha256").update(canonical(input.args)).digest("hex");
  const id = createHash("sha256")
    .update(`${input.turnId}\0${input.agentId}\0${input.toolName}\0${inputHash}`)
    .digest("hex");
  return { id, inputHash };
}

async function runJournaledAction(options: {
  turnId: string;
  agentId: AgentId;
  tool: TownFunctionTool;
  args: unknown;
  context?: TownToolInvocationContext;
  emitSemantic?: boolean;
}): Promise<ToolResult> {
  const { id, inputHash } = actionIdentity({
    turnId: options.turnId,
    agentId: options.agentId,
    toolName: options.tool.name,
    args: options.args,
  });
  const [claimed] = await db
    .insert(agentActionJournal)
    .values({
      id,
      turnId: options.turnId,
      toolCallId: options.context?.toolCallId,
      agentId: options.agentId,
      toolName: options.tool.name,
      inputHash,
      effect: options.tool.effect,
    })
    .onConflictDoNothing()
    .returning({ id: agentActionJournal.id });

  if (!claimed) {
    const [existing] = await db
      .select()
      .from(agentActionJournal)
      .where(eq(agentActionJournal.id, id));
    if (existing?.status === "completed") {
      await publishPendingSemanticAction(id).catch((error) =>
        console.error(`[action-journal] semantic event retry failed for ${id}:`, (error as Error).message),
      );
      return existing.result as ToolResult;
    }
    // Every external tool is required to forward this journal id as its own
    // provider/storage idempotency key. That makes the ambiguous crash window
    // safe to resume, unlike an ordinary world write whose outcome may need a
    // human/model inspection before another attempt.
    if (existing?.status === "started" && options.tool.effect === "external") {
      // Continue below with the same deterministic key.
    } else {
      // Never guess across the only unsafe crash window (journal claimed,
      // process died before completion). Repeating an email/DM/create is worse
      // than asking the mind to inspect canonical state and decide what remains.
      return existing?.status === "failed"
        ? `This exact action already failed in this turn: ${existing.error ?? "unknown error"}. Inspect current state before trying a different action.`
        : "A prior attempt at this exact action did not leave a confirmed result. It will not be repeated automatically; inspect canonical state before deciding what remains.";
    }
  }

  try {
    let applied = false;
    const result = await options.tool.run(options.args, {
      ...options.context,
      idempotencyKey: id,
      markApplied: () => {
        applied = true;
      },
    } satisfies TownToolInvocationContext);
    const semanticEvent =
      applied && options.tool.effect !== "read" && options.emitSemantic !== false
        ? await buildAgentActedEvent({
            actionId: id,
            agentId: options.agentId,
            tool: options.tool.name,
            effect: options.tool.effect,
            args: options.args,
            result,
          })
        : null;
    await db
      .update(agentActionJournal)
      .set({
        status: "completed",
        result,
        semanticEvent: semanticEvent as Record<string, unknown> | null,
        completedAt: new Date(),
      })
      .where(eq(agentActionJournal.id, id));
    if (semanticEvent) {
      await publishPendingSemanticAction(id).catch((error) =>
        console.error(`[action-journal] semantic event failed for ${id}:`, (error as Error).message),
      );
    }
    return result;
  } catch (error) {
    await db
      .update(agentActionJournal)
      .set({
        status: "failed",
        error: (error as Error).message.slice(0, 1_000),
        completedAt: new Date(),
      })
      .where(eq(agentActionJournal.id, id))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Publish one queued semantic action exactly once.
 *
 * The journal row is locked while the append-only event and its marker are
 * committed in the same transaction. A crash can therefore leave both absent
 * (safe to retry) or both present (already done), never an unmarked duplicate.
 */
export async function publishPendingSemanticAction(actionId: string): Promise<number | null> {
  const eventRow = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from agent_action_journal where id = ${actionId} for update`,
    );
    const [row] = await tx
      .select({
        semanticEvent: agentActionJournal.semanticEvent,
        semanticEventId: agentActionJournal.semanticEventId,
      })
      .from(agentActionJournal)
      .where(eq(agentActionJournal.id, actionId));
    if (!row?.semanticEvent || row.semanticEventId !== null) return null;

    const input = row.semanticEvent as unknown as AppendEventInput;
    const [inserted] = await tx
      .insert(worldEvents)
      .values({
        type: input.type,
        agentId: input.agentId ?? null,
        locationId: input.locationId ?? null,
        visitorId: input.visitorId ?? null,
        visibility: input.visibility,
        payload: input.payload,
      })
      .returning();
    await tx
      .update(agentActionJournal)
      .set({ semanticEventId: inserted.id, semanticEmittedAt: new Date() })
      .where(eq(agentActionJournal.id, actionId));
    return inserted;
  });

  if (!eventRow) return null;
  publishCommittedEvent(materializeEventRow(eventRow));
  return eventRow.id;
}

export async function flushPendingSemanticActions(limit = 100): Promise<{
  found: number;
  published: number;
  failed: number;
}> {
  const pending = await db
    .select({ id: agentActionJournal.id })
    .from(agentActionJournal)
    .where(
      and(
        eq(agentActionJournal.status, "completed"),
        isNotNull(agentActionJournal.semanticEvent),
        isNull(agentActionJournal.semanticEventId),
      ),
    )
    .limit(limit);
  let published = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      if ((await publishPendingSemanticAction(row.id)) !== null) published++;
    } catch (error) {
      failed++;
      console.error(
        `[action-journal] pending semantic event failed for ${row.id}:`,
        (error as Error).message,
      );
    }
  }
  return { found: pending.length, published, failed };
}

export function journalMutatingTools(
  tools: TownTool[],
  context: { turnId: string; agentId: AgentId },
): TownTool[] {
  return tools.map((tool) => {
    if (tool.kind === "memory") {
      const wrap = <T>(name: string, run: (input: T) => Promise<ToolResult> | ToolResult) =>
        (args: T) =>
          runJournaledAction({
            ...context,
            tool: {
              name: `memory.${name}`,
              effect: "write",
              run: (input: unknown) => run(input as T),
            } as TownFunctionTool,
            args,
            // Core-memory edits are durable interior cognition, not public body
            // actions. Journal them for continuity without broadcasting them.
            emitSemantic: false,
          });
      return {
        ...tool,
        handlers: {
          view: tool.handlers.view,
          create: wrap("create", tool.handlers.create),
          str_replace: wrap("str_replace", tool.handlers.str_replace),
          insert: wrap("insert", tool.handlers.insert),
          delete: wrap("delete", tool.handlers.delete),
          rename: wrap("rename", tool.handlers.rename),
        },
      };
    }
    if (tool.effect === "read") return tool;
    const source = tool as TownFunctionTool;
    return {
      ...source,
      run: (args: unknown, invocation?: unknown) =>
        runJournaledAction({
          ...context,
          tool: source,
          args,
          context: invocation as TownToolInvocationContext | undefined,
        }),
    } as TownFunctionTool;
  });
}
