import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";
import type {
  ToolResult,
  TownFunctionTool,
  TownTool,
  TownToolInvocationContext,
} from "./llm/tool.js";

const { agentActionJournal } = schema;

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
    if (existing?.status === "completed") return existing.result as ToolResult;
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
    const result = await options.tool.run(options.args, {
      ...options.context,
      idempotencyKey: id,
    } satisfies TownToolInvocationContext);
    await db
      .update(agentActionJournal)
      .set({ status: "completed", result, completedAt: new Date() })
      .where(eq(agentActionJournal.id, id));
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

export function journalMutatingTools(
  tools: TownTool[],
  context: { turnId: string; agentId: AgentId },
): TownTool[] {
  return tools.map((tool) => {
    if (tool.kind !== "function" || tool.effect === "read") return tool;
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
