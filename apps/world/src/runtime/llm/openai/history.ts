import { protocol, type AgentInputItem } from "@openai/agents";

const TRACE_MAX_CHARS = 8_000;

function clip(text: string): string {
  return text.length <= TRACE_MAX_CHARS
    ? text
    : `${text.slice(0, TRACE_MAX_CHARS)}\n[truncated: kept ${TRACE_MAX_CHARS} of ${text.length} characters; ${text.length - TRACE_MAX_CHARS} omitted]`;
}

function codeInterpreterLogs(outputs: unknown): string {
  if (!Array.isArray(outputs)) return "";
  // Retain useful execution evidence, never provider image URLs/base64 or
  // expiring container/file handles from the surrounding output objects.
  return outputs.flatMap((output: unknown) => {
    if (output == null || typeof output !== "object") return [];
    const value = output as { type?: unknown; logs?: unknown };
    return value.type === "logs" && typeof value.logs === "string" ? [value.logs] : [];
  }).join("\n");
}

export function validateOpenAIHistory(items: unknown[]): AgentInputItem[] {
  return items.map((item, index) => {
    const parsed = protocol.ModelItem.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        `Invalid OpenAI history item at index ${index}: ${parsed.error.issues[0]?.message ?? "unknown shape"}`,
      );
    }
    return parsed.data as AgentInputItem;
  });
}

function sanitizeUserFiles(item: AgentInputItem): AgentInputItem {
  if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) {
    return item;
  }
  return {
    ...item,
    content: item.content.map((part) => {
      if (
        part.type === "input_file" &&
        part.file != null &&
        typeof part.file === "object" &&
        "id" in part.file
      ) {
        return {
          type: "input_text" as const,
          text: `[a file (${part.filename ?? part.file.id}) was attached for that turn; its temporary provider handle is no longer replayed]`,
        };
      }
      return part;
    }),
  };
}

function sanitizeHostedTool(item: AgentInputItem): AgentInputItem {
  if (
    item.type !== "hosted_tool_call" ||
    (item.name !== "code_interpreter_call" &&
      item.providerData?.type !== "code_interpreter_call")
  ) {
    return item;
  }
  const source = item.providerData?.code ?? item.arguments;
  const code = clip(typeof source === "string" ? source : "");
  const output = clip(codeInterpreterLogs(item.providerData?.outputs));
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: `[you used Code Interpreter${code ? `:\n${code}` : ""}${output ? `\nIt returned:\n${output}` : ""}]`,
      },
    ],
  };
}

// The SDK owns compaction boundaries. Inline compaction replaces its old prefix,
// while standalone /responses/compact can retain user messages BEFORE its
// checkpoint. Preserve the complete SDK window; slicing at the checkpoint would
// discard those retained inputs. Only sanitize expiring file/container handles.
export function prepareOpenAIHistory(items: unknown[]): AgentInputItem[] {
  return validateOpenAIHistory(items).map(sanitizeHostedTool).map(sanitizeUserFiles);
}
