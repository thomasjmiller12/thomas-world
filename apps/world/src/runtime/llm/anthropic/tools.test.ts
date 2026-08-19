import { describe, expect, it } from "vitest";
import { buildTools, type AgentContext } from "../../tools.js";
import { toAnthropicTool, toAnthropicTools } from "./tools.js";
import { defineTownTool } from "../tool.js";
import * as z from "zod/v4";

describe("Anthropic town-tool adapter", () => {
  it("preserves the complete deterministic tool-name surface", () => {
    const ctx: AgentContext = { agentId: "career", location: "office" };
    const townTools = buildTools(ctx);
    const anthropicTools = toAnthropicTools(townTools);
    expect(anthropicTools.map((tool) => tool.name)).toEqual(townTools.map((tool) => tool.name));
    expect(anthropicTools.map((tool) => tool.name)).toEqual(
      [...anthropicTools.map((tool) => tool.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("keeps the generated JSON schema and validates before dispatch", async () => {
    const seen: unknown[] = [];
    const townTool = defineTownTool({
      name: "test_tool",
      description: "A contract fixture.",
      inputSchema: z.object({ count: z.number().int().positive() }),
      run: async (input) => {
        seen.push(input);
        return "ok";
      },
    });

    const wrapped = toAnthropicTool(townTool);
    const inputSchema = (wrapped as unknown as { input_schema: unknown }).input_schema;
    expect(inputSchema).toMatchObject({
      type: "object",
      required: ["count"],
      properties: { count: expect.objectContaining({ type: "integer" }) },
    });
    expect(() => wrapped.parse({ count: 0 })).toThrow();
    await expect(wrapped.run(wrapped.parse({ count: 2 }))).resolves.toBe("ok");
    expect(seen).toEqual([{ count: 2 }]);
  });

  it("keeps core memory as Anthropic's native memory tool", () => {
    const ctx: AgentContext = { agentId: "career", location: "office" };
    const memory = toAnthropicTools(buildTools(ctx)).find((tool) => tool.name === "memory");
    expect(memory).toMatchObject({ type: "memory_20250818", name: "memory" });
  });
});
