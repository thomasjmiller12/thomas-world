import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamFrame } from "@town/contract";
import { defineTownTool } from "../tool.js";
import * as z from "zod/v4";

const mocks = vi.hoisted(() => {
  const state = {
    run: vi.fn(),
    responsesCreate: vi.fn(),
    sessions: [] as Array<{
      items: unknown[];
      getItems: () => Promise<unknown[]>;
      addItems: (items: unknown[]) => Promise<void>;
    }>,
    createSession: vi.fn(),
  };
  state.createSession.mockImplementation((initialItems: unknown[]) => {
    const session = {
      items: [...initialItems],
      async getItems() {
        return [...this.items];
      },
      async addItems(items: unknown[]) {
        this.items.push(...items);
      },
    };
    state.sessions.push(session);
    return session;
  });
  return state;
});

vi.mock("./client.js", () => ({
  openaiRunner: { run: mocks.run },
  openaiClient: { responses: { create: mocks.responsesCreate } },
  createOpenAISession: mocks.createSession,
  OPENAI_CONTEXT_MANAGEMENT: [{ type: "compaction", compactThreshold: 50_000 }],
}));

import { openaiProvider } from "./provider.js";

function assistant(text: string) {
  return {
    type: "message" as const,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text }],
  };
}

function functionCall(name: string, callId = `call-${name}`) {
  return {
    type: "function_call" as const,
    callId,
    name,
    status: "completed" as const,
    arguments: "{}",
  };
}

function modelResponse(output: unknown[]) {
  return {
    usage: {},
    output,
  };
}

function fakeRunResult(responses: ReturnType<typeof modelResponse>[], streamed = false) {
  const result = {
    finalOutput: "done",
    rawResponses: responses,
    state: {
      usage: {
        requestUsageEntries: [
          {
            inputTokens: 100,
            outputTokens: 10,
            inputTokensDetails: { cached_tokens: 40 },
            endpoint: "responses.create",
          },
          {
            inputTokens: 20,
            outputTokens: 0,
            inputTokensDetails: {},
            endpoint: "responses.compact",
          },
        ],
      },
    },
    completed: Promise.resolve(),
    error: undefined,
    async *[Symbol.asyncIterator]() {
      if (streamed) yield { type: "run_item_stream_event" };
    },
  };
  return result;
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "builder" as const,
    model: { provider: "openai" as const, model: "gpt-5.4" },
    systemPrompt: "You are Builder Thomas.",
    inputText: "Inspect the workshop.",
    thread: { provider: "openai" as const, items: [] },
    tools: [
      defineTownTool({
        name: "look_around",
        description: "Look around",
        inputSchema: z.object({}).strict(),
        run: () => "workshop",
      }),
    ],
    maxTurns: 6,
    maxOutputTokens: 1_000,
    onUsage: vi.fn(async () => {}),
    ...overrides,
  };
}

async function persistFakeRunItems(
  options: { session: { addItems: (items: unknown[]) => Promise<void> } },
  responses: ReturnType<typeof modelResponse>[],
) {
  await options.session.addItems([
    { type: "message", role: "user", content: "Inspect the workshop." },
    ...responses.flatMap((response) => response.output),
  ]);
}

describe("OpenAI gpt-5.4 provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.length = 0;
  });

  it("runs the Agents SDK with the hard turn limit, strict tools, and 50k compaction", async () => {
    const responses = [
      modelResponse([assistant("Let me look."), functionCall("look_around")]),
      modelResponse([assistant("The workshop is ready.")]),
    ];
    mocks.run.mockImplementation(async (_agent, _input, options) => {
      await persistFakeRunItems(options, responses);
      return fakeRunResult(responses);
    });

    const request = baseRequest();
    const result = await openaiProvider.runTurn(request);

    const [agent, input, options] = mocks.run.mock.calls[0];
    expect(input).toBe("Inspect the workshop.");
    expect(options).toMatchObject({ maxTurns: 6 });
    expect(agent.model).toBe("gpt-5.4");
    expect(agent.modelSettings).toMatchObject({
      maxTokens: 1_000,
      reasoning: { effort: "low" },
      contextManagement: [{ type: "compaction", compactThreshold: 50_000 }],
    });
    expect(agent.tools.some((tool: { name?: string }) => tool.name === "code_interpreter")).toBe(
      true,
    );
    expect(result.rounds).toBe(2);
    expect(result.finalText).toBe("The workshop is ready.");
    expect(JSON.stringify(result.thread.items)).toContain("look_around");
  });

  it("records uncached input, cached input, and compaction as separate normalized usage", async () => {
    const responses = [modelResponse([assistant("Done.")])];
    mocks.run.mockImplementation(async (_agent, _input, options) => {
      await persistFakeRunItems(options, responses);
      return fakeRunResult(responses);
    });
    const onUsage = vi.fn(async () => {});

    await openaiProvider.runTurn(baseRequest({ onUsage }));

    expect(onUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        endpoint: "turn",
        inputTokens: 60,
        cacheReadTokens: 40,
        outputTokens: 10,
        round: 1,
      }),
    );
    expect(onUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ endpoint: "compact", inputTokens: 20, round: undefined }),
    );
  });

  it("emits only complete response-boundary speech and keeps finalText identical", async () => {
    const responses = [
      modelResponse([assistant("I will check."), functionCall("look_around")]),
      modelResponse([assistant("Here is the answer. Goodbye!"), functionCall("leave_chat")]),
      modelResponse([assistant("Now I update memory.")]),
    ];
    mocks.run.mockImplementation(async (_agent, _input, options) => {
      await persistFakeRunItems(options, responses);
      return fakeRunResult(responses, true);
    });
    const frames: ChatStreamFrame[] = [];

    const result = await openaiProvider.runTurn(
      baseRequest({
        onFrame: (frame: ChatStreamFrame) => {
          frames.push(frame);
        },
      }),
    );

    const text = frames
      .filter((frame): frame is Extract<ChatStreamFrame, { type: "text" }> => frame.type === "text")
      .map((frame) => frame.text)
      .join("\n\n");
    expect(text).toBe("Here is the answer. Goodbye!");
    expect(result.finalText).toBe(text);
  });

  it("discards the in-memory attempt when the SDK fails", async () => {
    mocks.run.mockRejectedValue(new Error("provider exploded"));
    const onUsage = vi.fn(async () => {});

    await expect(openaiProvider.runTurn(baseRequest({ onUsage }))).rejects.toThrow(
      "provider exploded",
    );
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("routes stateless generation through Responses and records its usage", async () => {
    mocks.responsesCreate.mockResolvedValue({
      output_text: "A concise summary.",
      usage: {
        input_tokens: 50,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 20 },
      },
    });
    const onUsage = vi.fn(async () => {});

    const text = await openaiProvider.generateText({
      model: { provider: "openai", model: "gpt-5.4" },
      systemPrompt: "Summarize.",
      inputText: "Source packet",
      maxOutputTokens: 300,
      onUsage,
    });

    expect(text).toBe("A concise summary.");
    expect(mocks.responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4", store: false }),
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        endpoint: "generate",
        inputTokens: 30,
        cacheReadTokens: 20,
      }),
    );
  });
});
