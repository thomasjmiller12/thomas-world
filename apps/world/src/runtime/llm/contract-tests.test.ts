import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicMessage,
  nonStreamingRunner,
  streamingRunner,
  traceStub,
} from "./contract-tests.js";

const mocks = vi.hoisted(() => ({
  toolRunner: vi.fn(),
  loadThread: vi.fn(),
  persistThread: vi.fn(),
  buildSeedContext: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("./anthropic/client.js", () => ({
  anthropic: { beta: { messages: { toolRunner: mocks.toolRunner } } },
  anthropicSystemBlocks: vi.fn(() => [{ type: "text", text: "system" }]),
  TICK_BETAS: [],
}));

vi.mock("../../engine/thread.js", () => ({
  loadThread: mocks.loadThread,
  persistThread: mocks.persistThread,
  buildSeedContext: mocks.buildSeedContext,
}));

vi.mock("../../engine/usage.js", () => ({
  recordNormalizedUsage: vi.fn(async (input) => {
    await mocks.recordUsage(input);
    return 0.01;
  }),
}));

vi.mock("../pricing.js", () => ({
  estimateCostUsd: vi.fn(() => 0.01),
}));

import { MAX_TURN_ROUNDS, runTurn } from "../turn.js";

const baseOptions = () => ({
  agentId: "builder" as const,
  model: { provider: "anthropic" as const, model: "claude-sonnet-5" },
  maxTokens: 1_000,
  inputText: "What should I do next?",
  tools: [],
  tickId: "contract-test",
  trace: traceStub(),
});

describe("runTurn provider contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadThread.mockResolvedValue({
      items: [{ role: "user", content: [{ type: "text", text: "existing" }] }],
      inputCursor: 41,
    });
    mocks.persistThread.mockResolvedValue(undefined);
    mocks.buildSeedContext.mockResolvedValue("seed");
    mocks.recordUsage.mockResolvedValue(undefined);
  });

  it("delegates a hard six-round limit to the SDK runner", async () => {
    const rounds = Array.from({ length: MAX_TURN_ROUNDS }, (_, i) =>
      anthropicMessage({ text: `round ${i + 1}`, stopReason: "tool_use" }),
    );
    mocks.toolRunner.mockImplementation((params) => nonStreamingRunner(params, rounds));

    const result = await runTurn(baseOptions());

    expect(mocks.toolRunner).toHaveBeenCalledWith(
      expect.objectContaining({ max_iterations: MAX_TURN_ROUNDS }),
    );
    expect(result.rounds).toBe(MAX_TURN_ROUNDS);
  });

  it("does not persist a partial thread when the provider fails", async () => {
    mocks.toolRunner.mockImplementation((params) =>
      nonStreamingRunner(params, [anthropicMessage({ text: "partial", stopReason: "tool_use" })], {
        failAfter: 1,
      }),
    );

    await expect(runTurn(baseOptions())).rejects.toThrow("provider exploded");
    expect(mocks.persistThread).not.toHaveBeenCalled();
  });

  it("persists every successful model round and the triggering input", async () => {
    const rounds = [
      anthropicMessage({ text: "checking", stopReason: "tool_use" }),
      anthropicMessage({ text: "done", stopReason: "end_turn" }),
    ];
    mocks.toolRunner.mockImplementation((params) => nonStreamingRunner(params, rounds));

    await runTurn(baseOptions());

    expect(mocks.persistThread).toHaveBeenCalledOnce();
    expect(mocks.persistThread.mock.calls[0].slice(0, 2)).toEqual(["builder", "anthropic"]);
    const persisted = mocks.persistThread.mock.calls[0][2] as unknown[];
    expect(JSON.stringify(persisted)).toContain("What should I do next?");
    expect(JSON.stringify(persisted)).toContain("checking");
    expect(JSON.stringify(persisted)).toContain("done");
    expect(JSON.stringify(persisted)).not.toContain("cache_control");
  });

  it("translates an Anthropic-owned attachment inside the Anthropic adapter", async () => {
    const rounds = [anthropicMessage({ text: "analyzed", stopReason: "end_turn" })];
    mocks.toolRunner.mockImplementation((params) => nonStreamingRunner(params, rounds));

    await runTurn({
      ...baseOptions(),
      attachment: {
        provider: "anthropic",
        fileId: "file-anthropic-dataset",
        filename: "data.csv",
      },
    });

    const params = mocks.toolRunner.mock.calls[0][0] as { messages: unknown[] };
    expect(JSON.stringify(params.messages)).toContain(
      '"type":"container_upload","file_id":"file-anthropic-dataset"',
    );
  });

  it("surfaces refusal explicitly and stops consuming later rounds", async () => {
    const rounds = [
      anthropicMessage({ text: "no", stopReason: "refusal" }),
      anthropicMessage({ text: "must not run", stopReason: "end_turn" }),
    ];
    mocks.toolRunner.mockImplementation((params) => nonStreamingRunner(params, rounds));

    const result = await runTurn(baseOptions());

    expect(result.refused).toBe(true);
    expect(result.rounds).toBe(1);
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
  });

  it("makes finalText byte-for-byte equal to streamed visitor text", async () => {
    const frames: string[] = [];
    const rounds = [
      { text: "Let me check.", message: anthropicMessage({ text: "Let me check.", stopReason: "tool_use" }) },
      {
        text: "Here is the answer. Goodbye!",
        message: anthropicMessage({
          text: "Here is the answer. Goodbye!",
          stopReason: "tool_use",
          toolName: "leave_chat",
        }),
      },
      {
        text: "Now I will update memory.",
        message: anthropicMessage({ text: "Now I will update memory.", stopReason: "end_turn" }),
      },
    ];
    mocks.toolRunner.mockImplementation((params) => streamingRunner(params, rounds));

    const result = await runTurn({
      ...baseOptions(),
      stream: {
        onFrame(frame) {
          if (frame.type === "text") frames.push(frame.text);
        },
      },
    });

    expect(frames.join("\n\n")).toBe("Here is the answer. Goodbye!");
    expect(result.finalText).toBe(frames.join("\n\n"));
  });

  it("releases all held narration when no round produces speech", async () => {
    const frames: string[] = [];
    const rounds = [
      { text: "First useful thought", message: anthropicMessage({ text: "First useful thought", stopReason: "tool_use" }) },
      { text: "Second useful thought", message: anthropicMessage({ text: "Second useful thought", stopReason: "tool_use" }) },
    ];
    mocks.toolRunner.mockImplementation((params) => streamingRunner(params, rounds));

    const result = await runTurn({
      ...baseOptions(),
      stream: {
        onFrame(frame) {
          if (frame.type === "text") frames.push(frame.text);
        },
      },
    });

    expect(frames).toEqual(["First useful thought\n\nSecond useful thought"]);
    expect(result.finalText).toBe(frames[0]);
  });
});
