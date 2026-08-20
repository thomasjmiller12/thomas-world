import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { defineTownTool } from "../tool.js";
import { anthropicProvider } from "./provider.js";

const live = process.env.ANTHROPIC_LIVE_TEST === "1";

describe.skipIf(!live)("Anthropic provider live smoke", () => {
  it(
    "executes a tool, completes the next model round, and resumes its persisted native thread",
    async () => {
      const marker = "town-anthropic-provider-resume-42";
      const toolCalls: string[] = [];
      const rememberMarker = defineTownTool({
        name: "remember_marker",
        description: "Record the test marker and return it unchanged.",
        inputSchema: z.object({ marker: z.string() }).strict(),
        run: ({ marker: value }) => {
          toolCalls.push(value);
          return `marker accepted: ${value}`;
        },
      });

      const first = await anthropicProvider.runTurn({
        agentId: "builder",
        model: { provider: "anthropic", model: "claude-sonnet-5" },
        systemPrompt:
          "You are a provider integration test. Follow the user's tool-use and output-format instructions exactly.",
        inputText:
          `Call remember_marker exactly once with marker ${JSON.stringify(marker)}. ` +
          `After the tool returns, respond exactly with "tool-ok".`,
        thread: { provider: "anthropic", items: [] },
        tools: [rememberMarker],
        maxTurns: 6,
        maxOutputTokens: 200,
        onUsage: async () => {},
      });

      expect(toolCalls).toEqual([marker]);
      expect(first.rounds).toBeGreaterThanOrEqual(2);
      expect(first.finalText).toContain("tool-ok");
      expect(first.thread.items.length).toBeGreaterThan(0);

      const resumed = await anthropicProvider.runTurn({
        agentId: "builder",
        model: { provider: "anthropic", model: "claude-sonnet-5" },
        systemPrompt:
          "You are a provider integration test. Answer from your continuous native thread.",
        inputText: "What exact marker did the tool accept? Reply with only the marker.",
        thread: first.thread,
        tools: [],
        maxTurns: 6,
        maxOutputTokens: 100,
        onUsage: async () => {},
      });

      expect(resumed.finalText).toContain(marker);
      expect(resumed.thread.items.length).toBeGreaterThan(first.thread.items.length);
    },
    120_000,
  );
});
