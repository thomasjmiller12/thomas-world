import * as z from "zod/v4";

export type ToolResult = string | unknown[];
export type Promisable<T> = T | Promise<T>;
export type ToolEffect = "read" | "write" | "external";

export interface TownToolInvocationContext {
  provider?: "anthropic" | "openai";
  toolCallId?: string;
  // Stable across provider retries for the same logical action. External tool
  // handlers pass this through to providers such as Resend.
  idempotencyKey?: string;
  raw?: unknown;
}

export interface TownFunctionTool<InputSchema extends z.ZodType = z.ZodType> {
  kind: "function";
  name: string;
  description: string;
  inputSchema: InputSchema;
  strict: boolean;
  effect: ToolEffect;
  run: (args: z.infer<InputSchema>, context?: unknown) => Promisable<ToolResult>;
  close?: () => Promisable<void>;
  terminalSpeech?: boolean;
}

export interface MemoryToolHandlers {
  view: (command: {
    command: "view";
    path: string;
    view_range?: [number, number];
  }) => Promisable<ToolResult>;
  create: (command: {
    command: "create";
    path: string;
    file_text: string;
  }) => Promisable<ToolResult>;
  str_replace: (command: {
    command: "str_replace";
    path: string;
    old_str: string;
    new_str: string;
  }) => Promisable<ToolResult>;
  insert: (command: {
    command: "insert";
    path: string;
    insert_line: number;
    insert_text: string;
  }) => Promisable<ToolResult>;
  delete: (command: { command: "delete"; path: string }) => Promisable<ToolResult>;
  rename: (command: {
    command: "rename";
    old_path: string;
    new_path: string;
  }) => Promisable<ToolResult>;
}

export interface TownMemoryTool {
  kind: "memory";
  name: "memory";
  description: string;
  strict: true;
  effect: "write";
  handlers: MemoryToolHandlers;
}

export type TownTool = TownFunctionTool<z.ZodType> | TownMemoryTool;

export function defineTownTool<InputSchema extends z.ZodType>(options: {
  name: string;
  description: string;
  inputSchema: InputSchema;
  run: (args: z.infer<InputSchema>, context?: unknown) => Promisable<ToolResult>;
  close?: () => Promisable<void>;
  strict?: boolean;
  terminalSpeech?: boolean;
  effect?: ToolEffect;
}): TownFunctionTool<InputSchema> {
  return {
    kind: "function",
    strict: options.strict ?? true,
    effect: options.effect ?? "read",
    ...options,
  };
}

export function defineTownMemoryTool(handlers: MemoryToolHandlers): TownMemoryTool {
  return {
    kind: "memory",
    name: "memory",
    description: "View and edit your durable core-memory files.",
    strict: true,
    effect: "write",
    handlers,
  };
}
