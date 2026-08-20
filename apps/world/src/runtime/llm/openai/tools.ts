import { tool, type FunctionTool } from "@openai/agents";
import * as z from "zod/v4";
import type {
  MemoryToolHandlers,
  ToolResult,
  TownFunctionTool,
  TownMemoryTool,
  TownTool,
  TownToolInvocationContext,
} from "../tool.js";

export type OpenAIFunctionTool = FunctionTool<unknown, any, any>;

function renderToolResult(result: ToolResult): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

// OpenAI strict function schemas require every property to be present. Fields
// that are command-specific are therefore required-but-nullable; the dispatcher
// turns null back into absence before calling the existing memory handlers.
export const openAIMemoryCommandSchema = z
  .object({
    command: z.enum(["view", "create", "str_replace", "insert", "delete", "rename"]),
    path: z.string().nullable(),
    // Responses strict schemas do not accept Draft 7 tuple-form `items` arrays.
    // A fixed-length homogeneous array preserves the [start, end] wire shape.
    view_range: z.array(z.number().int()).length(2).nullable(),
    file_text: z.string().nullable(),
    old_str: z.string().nullable(),
    new_str: z.string().nullable(),
    insert_line: z.number().int().nullable(),
    insert_text: z.string().nullable(),
    old_path: z.string().nullable(),
    new_path: z.string().nullable(),
  })
  .strict();

type OpenAIMemoryCommand = z.infer<typeof openAIMemoryCommandSchema>;

function required<T>(value: T | null, field: string, command: string): T {
  if (value == null) throw new Error(`memory.${command} requires ${field}`);
  return value;
}

async function runMemoryCommand(
  handlers: MemoryToolHandlers,
  command: OpenAIMemoryCommand,
): Promise<string> {
  let result: ToolResult;
  switch (command.command) {
    case "view":
      result = await handlers.view({
        command: "view",
        path: required(command.path, "path", command.command),
        ...(command.view_range
          ? { view_range: [command.view_range[0], command.view_range[1]] }
          : {}),
      });
      break;
    case "create":
      result = await handlers.create({
        command: "create",
        path: required(command.path, "path", command.command),
        file_text: required(command.file_text, "file_text", command.command),
      });
      break;
    case "str_replace":
      result = await handlers.str_replace({
        command: "str_replace",
        path: required(command.path, "path", command.command),
        old_str: required(command.old_str, "old_str", command.command),
        new_str: required(command.new_str, "new_str", command.command),
      });
      break;
    case "insert":
      result = await handlers.insert({
        command: "insert",
        path: required(command.path, "path", command.command),
        insert_line: required(command.insert_line, "insert_line", command.command),
        insert_text: required(command.insert_text, "insert_text", command.command),
      });
      break;
    case "delete":
      result = await handlers.delete({
        command: "delete",
        path: required(command.path, "path", command.command),
      });
      break;
    case "rename":
      result = await handlers.rename({
        command: "rename",
        old_path: required(command.old_path, "old_path", command.command),
        new_path: required(command.new_path, "new_path", command.command),
      });
      break;
  }
  return renderToolResult(result);
}

function toOpenAIMemoryTool(memory: TownMemoryTool): OpenAIFunctionTool {
  return tool({
    name: memory.name,
    description:
      `${memory.description} Send every field; use null for fields that do not apply to the selected command.`,
    parameters: openAIMemoryCommandSchema,
    strict: true,
    execute: (command) => runMemoryCommand(memory.handlers, command),
  }) as OpenAIFunctionTool;
}

export function toOpenAITool(townTool: TownTool): OpenAIFunctionTool {
  if (townTool.kind === "memory") return toOpenAIMemoryTool(townTool);
  const fn = townTool as TownFunctionTool;
  return tool({
    name: fn.name,
    description: fn.description,
    parameters: fn.inputSchema as z.ZodObject<any>,
    strict: true,
    execute: async (args, context, details) => {
      const toolCall = details?.toolCall as { callId?: string; call_id?: string; id?: string } | undefined;
      const invocation: TownToolInvocationContext = {
        provider: "openai",
        toolCallId: toolCall?.callId ?? toolCall?.call_id ?? toolCall?.id,
        raw: context,
      };
      return renderToolResult(await fn.run(args, invocation));
    },
  }) as OpenAIFunctionTool;
}

export function toOpenAITools(tools: TownTool[]): OpenAIFunctionTool[] {
  return tools.map(toOpenAITool);
}
