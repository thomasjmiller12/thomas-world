import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import {
  Agent,
  MemorySession,
  OpenAIProvider,
  OpenAIResponsesCompactionSession,
  Runner,
  tool,
  type AgentInputItem,
} from "@openai/agents";
import * as z from "zod/v4";
import { prepareOpenAIHistory } from "./history.js";
import { createOpenAISession, OPENAI_CONTEXT_MANAGEMENT } from "./client.js";

// Exercise the installed SDK's real response conversion and session persistence.
// Only HTTP responses are mocked; no model or database requests leave the test.
function mockedClient(replies: { path: string; body: unknown }[]) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift();
    expect(reply?.path).toBe(path);
    return new Response(JSON.stringify(reply!.body), {
      headers: { "content-type": "application/json" },
    });
  });
  const client = new OpenAI({ apiKey: "offline-test", fetch, maxRetries: 0 });
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ openAIClient: client, useResponses: true }),
    tracingDisabled: true,
  });
  return { client, runner, requests };
}

function assistant(text: string) {
  return {
    type: "message",
    id: `msg-${text}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

function response(output: unknown[]) {
  return {
    id: "resp-offline",
    object: "response",
    status: "completed",
    output,
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  };
}

const checkpoint = {
  type: "compaction" as const,
  id: "cmp-offline",
  encrypted_content: "opaque-checkpoint-do-not-interpret",
};

// Same history normalization and JSON round-trip as the provider + JSONB row.
async function persistAndReload(session: { getItems(): Promise<AgentInputItem[]> }) {
  const persisted = prepareOpenAIHistory(await session.getItems());
  const reloaded = prepareOpenAIHistory(JSON.parse(JSON.stringify(persisted)));
  expect(reloaded).toEqual(persisted);
  return createOpenAISession(reloaded);
}

describe("OpenAI SDK compaction persistence", () => {
  it("preserves the complete standalone output when normalizing persisted history", async () => {
    const retained = {
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "2026-09-24: Next step is experiment B." }],
    };
    const { client, runner, requests } = mockedClient([
      { path: "/v1/responses", body: response([assistant("Ready for tomorrow.")]) },
      {
        path: "/v1/responses/compact",
        body: { ...response([retained, checkpoint]), object: "response.compaction" },
      },
    ]);
    const session = new OpenAIResponsesCompactionSession({
      client,
      underlyingSession: new MemorySession(),
      model: "gpt-5.4",
      compactionMode: "input",
      shouldTriggerCompaction: () => true,
    });
    const agent = new Agent({ name: "researcher", model: "gpt-5.4" });

    await runner.run(agent, [retained], { session });
    const compacted = await session.getItems();
    expect(compacted).toMatchObject([retained, checkpoint]);
    const reloaded = await persistAndReload(session);
    expect(await reloaded.getItems()).toEqual(compacted);
    // This pins lossless app normalization, not SDK replay of standalone output.
    // The production factory uses inline-only compaction because SDK 0.16.1
    // prunes standalone retained inputs when preparing the next model request.
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/responses", "/v1/responses/compact",
    ]);
  });

  it("leaves compaction to Responses rather than compacting serialized history again", async () => {
    const oldInput = "2026-09-24: Keep this project context. " + "x".repeat(200_000);
    const { runner, requests } = mockedClient([
      { path: "/v1/responses", body: response([assistant("Ready for tomorrow.")]) },
      { path: "/v1/responses", body: response([assistant("Continuing.")]) },
    ]);
    const agent = new Agent({
      name: "researcher",
      model: "gpt-5.4",
      modelSettings: { store: false, contextManagement: [...OPENAI_CONTEXT_MANAGEMENT] },
    });
    const session = createOpenAISession([{ type: "message", role: "user", content: oldInput }]);

    await runner.run(agent, "Finish today's turn.", { session });
    const reloaded = await persistAndReload(session);
    await runner.run(agent, "2026-09-25: Continue.", { session: reloaded });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.path).toBe("/v1/responses");
      expect(request.body.context_management).toEqual([{ type: "compaction", compact_threshold: 50_000 }]);
    }
    expect(JSON.stringify(requests[1].body.input)).toContain(oldInput);
    expect(requests[1].body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "2026-09-25: Continue." }),
    ]));
  });

  it("lets the SDK replace the inline prefix and preserves a later tool call/result pair", async () => {
    const { runner, requests } = mockedClient([
      {
        path: "/v1/responses",
        body: response([
          checkpoint,
          { type: "function_call", id: "fc-offline", call_id: "call-offline", name: "look_around", arguments: "{}", status: "completed" },
        ]),
      },
      { path: "/v1/responses", body: response([assistant("The workshop is ready.")]) },
      { path: "/v1/responses", body: response([assistant("Still here.")]) },
    ]);
    const session = createOpenAISession([
      { type: "message", role: "user", content: "Old prefix replaced by inline compaction." },
    ]);
    const lookAround = vi.fn(() => "You are in the workshop.");
    const agent = new Agent({
      name: "builder",
      model: "gpt-5.4",
      modelSettings: { store: false, contextManagement: [...OPENAI_CONTEXT_MANAGEMENT] },
      tools: [tool({ name: "look_around", description: "Look around", parameters: z.object({}), execute: lookAround })],
    });

    await runner.run(agent, "Check the workshop.", { session });
    const compacted = await session.getItems();
    expect(compacted[0]).toMatchObject(checkpoint);
    expect(JSON.stringify(compacted)).not.toContain("Old prefix");
    expect(lookAround).toHaveBeenCalledOnce();
    expect(compacted.filter((item) => item.type === "function_call" || item.type === "function_call_result")).toMatchObject([
      { type: "function_call", callId: "call-offline", name: "look_around" },
      { type: "function_call_result", callId: "call-offline", output: { type: "text", text: "You are in the workshop." } },
    ]);

    const reloaded = await persistAndReload(session);
    expect(await reloaded.getItems()).toEqual(compacted);
    await runner.run(agent, "Continue after restart.", { session: reloaded });
    expect(requests[2].body.input).toMatchObject([
      checkpoint,
      { type: "function_call", call_id: "call-offline" },
      { type: "function_call_output", call_id: "call-offline", output: "You are in the workshop." },
      { role: "assistant" },
      { role: "user", content: "Continue after restart." },
    ]);
    expect(requests).toHaveLength(3);
  });
});
