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

  it("preserves retained user inputs before a standalone compaction checkpoint", () => {
    const checkpoint = {
      type: "compaction",
      encrypted_content: "opaque-compaction-state",
      created_by: "gpt-5.4",
    };
    const window = [
      { type: "message", role: "user", content: "Continue the experiment tomorrow." },
      checkpoint,
      { type: "message", role: "user", content: "after" },
    ];

    expect(prepareOpenAIHistory(window)).toEqual(window);
  });

  it("replaces expired Code Interpreter container state with a bounded textual trace", () => {
    const prepared = prepareOpenAIHistory(CAPTURED_OPENAI_ITEMS);
    const serialized = JSON.stringify(prepared);

    expect(serialized).toContain("you used Code Interpreter");
    expect(serialized).toContain("print(2 + 2)");
    expect(serialized).not.toContain("cntr_expiring");
    expect(serialized).not.toContain("code_interpreter_call");
  });

  it("preserves a small executed script and its complete exact-bootstrap output", () => {
    // Public synthetic test from the isolated 2026-09-25 live Python probe.
    // Both the script and stdout exceed the old 600-character trace cap.
    const code = `import importlib, itertools, json
import numpy as np, pandas as pd, scipy, sklearn
from pathlib import Path
versions = {m: importlib.import_module(m).__version__ for m in ["numpy", "pandas", "scipy", "sklearn"]}
x = [1, 2, 4] # SYNTHETIC TEST DATA, not town research or visitor data
means = np.array([np.mean(sample) for sample in itertools.product(x, repeat=3)])
result = {"label": "isolated capability test using synthetic data", "arithmetic": 17*19, "versions": versions, "sample": x, "exact_bootstrap_draws": len(means), "exact_bootstrap_mean": float(means.mean()), "exact_bootstrap_variance": float(means.var()), "bootstrap_means": means.tolist()}
Path("/mnt/data/town-capability-probe.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))`;
    const stdout = '{"label": "isolated capability test using synthetic data", "arithmetic": 323, "versions": {"numpy": "2.3.5", "pandas": "2.2.3", "scipy": "1.17.0", "sklearn": "1.8.0", "sentence-transformers": "not installed"}, "sample": [1, 2, 4], "exact_bootstrap_draws": 27, "exact_bootstrap_mean": 2.3333333333333335, "exact_bootstrap_variance": 0.5185185185185185, "bootstrap_means": [1.0, 1.3333333333333333, 2.0, 1.3333333333333333, 1.6666666666666667, 2.3333333333333335, 2.0, 2.3333333333333335, 3.0, 1.3333333333333333, 1.6666666666666667, 2.3333333333333335, 1.6666666666666667, 2.0, 2.6666666666666665, 2.3333333333333335, 2.6666666666666665, 3.3333333333333335, 2.0, 2.3333333333333335, 3.0, 2.3333333333333335, 2.6666666666666665, 3.3333333333333335, 3.0, 3.3333333333333335, 4.0]}\n';
    const prepared = prepareOpenAIHistory([{
      type: "hosted_tool_call",
      id: "ci_synthetic_probe",
      name: "code_interpreter_call",
      status: "completed",
      providerData: {
        type: "code_interpreter_call", code,
        outputs: [{ type: "logs", logs: stdout }],
        container_id: "cntr_temporary",
      },
    }]);
    const serialized = JSON.stringify(prepared);

    expect(code.length).toBeGreaterThan(600);
    expect(stdout.length).toBeGreaterThan(600);
    expect(serialized).toContain(JSON.stringify(code).slice(1, -1));
    expect(serialized).toContain(JSON.stringify(stdout).slice(1, -1));
    expect(serialized).toContain("3.3333333333333335, 4.0]");
    expect(serialized).not.toContain("truncated");
    expect(serialized).not.toContain("cntr_temporary");
    expect(prepareOpenAIHistory(prepared)).toEqual(prepared);
  });

  it("bounds code and text logs independently and excludes image/provider payloads", () => {
    const serialized = JSON.stringify(prepareOpenAIHistory([{
      type: "hosted_tool_call",
      name: "code_interpreter_call",
      status: "completed",
      providerData: {
        type: "code_interpreter_call",
        code: "c".repeat(8_051),
        container_id: "cntr_temporary",
        outputs: [
          { type: "image", url: "data:image/png;base64,IMAGE_PAYLOAD", file_id: "file_temporary" },
          { type: "logs", logs: "l".repeat(8_057), container_id: "cntr_temporary" },
        ],
      },
    }]));

    expect(serialized).toContain("c".repeat(8_000));
    expect(serialized).not.toContain("c".repeat(8_001));
    expect(serialized).toContain("l".repeat(8_000));
    expect(serialized).not.toContain("l".repeat(8_001));
    expect(serialized).toContain("kept 8000 of 8051 characters; 51 omitted");
    expect(serialized).toContain("kept 8000 of 8057 characters; 57 omitted");
    expect(serialized).not.toMatch(/cntr_temporary|file_temporary|IMAGE_PAYLOAD|data:image/);
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
