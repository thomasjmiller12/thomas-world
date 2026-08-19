import { describe, expect, it } from "vitest";
import { prepareOpenAIHistory, validateOpenAIHistory } from "./history.js";

// Captured AgentInputItem shapes emitted by @openai/agents 0.16.1 over the
// Responses API. Keep this fixture broad: these are the item kinds whose
// lossless persistence matters to a continuous native OpenAI thread.
const CAPTURED_OPENAI_ITEMS: unknown[] = [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "I will check." }],
  },
  {
    type: "function_call",
    id: "fc_1",
    callId: "call_1",
    name: "look_around",
    status: "completed",
    arguments: "{}",
  },
  {
    type: "function_call_result",
    callId: "call_1",
    name: "look_around",
    status: "completed",
    output: "You are in the workshop.",
  },
  {
    type: "reasoning",
    id: "rs_1",
    content: [{ type: "input_text", text: "Need to inspect the room." }],
    rawContent: [{ type: "reasoning_text", text: "encrypted-or-summary" }],
  },
  {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: "opaque-compaction-state",
    created_by: "gpt-5.4",
  },
  {
    type: "hosted_tool_call",
    id: "ci_1",
    name: "code_interpreter_call",
    status: "completed",
    providerData: {
      type: "code_interpreter_call",
      code: "print(2 + 2)",
      outputs: [{ type: "logs", logs: "4" }],
      container_id: "cntr_expiring",
    },
  },
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: "I can't help with that." }],
  },
];

describe("OpenAI native history", () => {
  it("validates assistant, function, reasoning, code, compaction, and refusal items", () => {
    expect(validateOpenAIHistory(CAPTURED_OPENAI_ITEMS)).toHaveLength(7);
  });

  it("rejects malformed native history before it reaches the SDK session", () => {
    expect(() => validateOpenAIHistory([{ type: "function_call", name: "missing-fields" }])).toThrow(
      /Invalid OpenAI history item at index 0/,
    );
  });

  it("keeps the newest compaction item and only its authoritative suffix", () => {
    const olderCompaction = {
      type: "compaction",
      encrypted_content: "older",
      created_by: "gpt-5.4",
    };
    const prepared = prepareOpenAIHistory([
      olderCompaction,
      ...CAPTURED_OPENAI_ITEMS,
      { type: "message", role: "user", content: "after" },
    ]);

    expect(prepared[0]).toMatchObject({ type: "compaction", id: "cmp_1" });
    expect(JSON.stringify(prepared)).not.toContain("older");
  });

  it("replaces expired Code Interpreter container state with a bounded textual trace", () => {
    const prepared = prepareOpenAIHistory(CAPTURED_OPENAI_ITEMS);
    const serialized = JSON.stringify(prepared);

    expect(serialized).toContain("you used Code Interpreter");
    expect(serialized).toContain("print(2 + 2)");
    expect(serialized).not.toContain("cntr_expiring");
    expect(serialized).not.toContain("code_interpreter_call");
  });

  it("replaces temporary file ids embedded in old user turns", () => {
    const prepared = prepareOpenAIHistory([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file: { id: "file_expired" }, filename: "data.csv" }],
      },
    ]);

    expect(JSON.stringify(prepared)).toContain("data.csv");
    expect(JSON.stringify(prepared)).not.toContain("file_expired");
  });
});
