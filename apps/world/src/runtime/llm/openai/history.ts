import { protocol, type AgentInputItem } from "@openai/agents";

const TRACE_MAX_CHARS = 600;

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length <= TRACE_MAX_CHARS
    ? text
    : `${text.slice(0, TRACE_MAX_CHARS)}… (truncated)`;
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
  const code = clip(item.providerData?.code ?? item.arguments ?? "");
  const output = clip(item.providerData?.outputs ?? item.output ?? "");
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

// Validate provider-native items, keep only the authoritative suffix after the
// newest compaction checkpoint, and remove temporary file/container handles
// that cannot be replayed after their provider-side lifetime expires.
export function prepareOpenAIHistory(items: unknown[]): AgentInputItem[] {
  const validated = validateOpenAIHistory(items);
  let start = 0;
  for (let index = 0; index < validated.length; index++) {
    if (validated[index].type === "compaction") start = index;
  }
  return validated.slice(start).map(sanitizeHostedTool).map(sanitizeUserFiles);
}
