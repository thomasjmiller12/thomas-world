import type Anthropic from "@anthropic-ai/sdk";

export type AnthropicThreadMessage = Anthropic.Beta.BetaMessageParam;

const EPHEMERAL_BLOCK_TYPES = new Set([
  "server_tool_use",
  "code_execution_tool_use",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "container_upload",
  "mcp_tool_use",
  "mcp_tool_result",
]);

const TRACE_MAX_CHARS = 600;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (truncated)`;
}

export function summarizeEphemeralBlock(block: unknown): string | undefined {
  const b = block as {
    type: string;
    name?: string;
    input?: { code?: string } & Record<string, unknown>;
    content?: unknown;
  };
  switch (b.type) {
    case "server_tool_use":
    case "code_execution_tool_use":
    case "mcp_tool_use": {
      const name = b.name ?? "a server-side tool";
      const code = typeof b.input?.code === "string" ? b.input.code : undefined;
      if (code) return `[you ran ${name}:\n${clip(code, TRACE_MAX_CHARS)}]`;
      return `[you called ${name}: ${clip(JSON.stringify(b.input ?? {}), 200)}]`;
    }
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "mcp_tool_result": {
      const rendered = renderToolResult(b.content);
      return rendered ? `[it returned:\n${clip(rendered, TRACE_MAX_CHARS)}]` : undefined;
    }
    case "container_upload":
      return "[a dataset file was handed to your sandbox for this turn]";
    default:
      return undefined;
  }
}

function renderToolResult(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  const c = content as { stdout?: string; stderr?: string; error_code?: string };
  const parts = [c.stdout, c.stderr && `stderr: ${c.stderr}`, c.error_code && `error: ${c.error_code}`]
    .filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length) return parts.join("\n");
  return JSON.stringify(content);
}

export function stripForPersist(messages: AnthropicThreadMessage[]): AnthropicThreadMessage[] {
  const out: AnthropicThreadMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content: AnthropicThreadMessage["content"] = [];
    let keptReal = false;
    for (const b of m.content) {
      if (EPHEMERAL_BLOCK_TYPES.has((b as { type: string }).type)) {
        const trace = summarizeEphemeralBlock(b);
        if (trace) content.push({ type: "text", text: trace } as (typeof content)[number]);
        continue;
      }
      keptReal = true;
      content.push(
        "cache_control" in b && b.cache_control != null ? { ...b, cache_control: undefined } : b,
      );
    }
    if (content.length === 0) continue;

    const prev = out[out.length - 1];
    if (!keptReal && prev && prev.role === m.role && Array.isArray(prev.content)) {
      prev.content = [...prev.content, ...content];
      continue;
    }
    out.push({ ...m, content });
  }
  return out.map((m) =>
    Array.isArray(m.content) ? { ...m, content: collapseThinking(m.content) } : m,
  );
}

const KEEP_COMPACTIONS = 2;

export function pruneCompactedHistory(
  messages: AnthropicThreadMessage[],
  keepCompactions = KEEP_COMPACTIONS,
): AnthropicThreadMessage[] {
  const compactionAt: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (
      Array.isArray(content) &&
      content.some((block) => (block as { type?: string }).type === "compaction")
    ) {
      compactionAt.push(i);
    }
  }
  if (compactionAt.length < keepCompactions) return messages;
  const from = compactionAt[compactionAt.length - keepCompactions];
  if (from <= 0) return messages;
  const kept = messages.slice(from);
  console.log(
    `[thread] pruned ${from} pre-compaction message(s); ${kept.length} retained ` +
      `(${compactionAt.length} checkpoints seen, keeping last ${keepCompactions}).`,
  );
  return kept;
}

function collapseThinking(
  blocks: AnthropicThreadMessage["content"],
): AnthropicThreadMessage["content"] {
  if (typeof blocks === "string") return blocks;
  let seenThinking = false;
  const kept = blocks.filter((block) => {
    const type = (block as { type?: string }).type;
    if (type !== "thinking" && type !== "redacted_thinking") return true;
    if (seenThinking) return false;
    seenThinking = true;
    return true;
  });
  if (kept.length !== blocks.length) {
    console.warn(
      `[thread] dropped ${blocks.length - kept.length} extra thinking block(s) before persist ` +
        `(would poison the thread on replay).`,
    );
  }
  return kept;
}
