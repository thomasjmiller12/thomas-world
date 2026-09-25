import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";
import type { TownFunctionTool, TownTool, TownToolInvocationContext } from "../tool.js";

export type AnthropicRunnableTool = BetaRunnableTool<unknown>;

export function toAnthropicTool(tool: TownTool): AnthropicRunnableTool {
  if (tool.kind === "memory") {
    return betaMemoryTool(
      tool.handlers as Parameters<typeof betaMemoryTool>[0],
    ) as AnthropicRunnableTool;
  }

  const fn = tool as TownFunctionTool;
  return betaZodTool({
    name: fn.name,
    description: fn.description,
    inputSchema: fn.inputSchema,
    run: (args, context) => {
      const invocation: TownToolInvocationContext = {
        provider: "anthropic",
        toolCallId: context?.toolUse.id,
        raw: context,
      };
      return fn.run(args, invocation) as ReturnType<AnthropicRunnableTool["run"]>;
    },
    ...(fn.close ? { close: fn.close } : {}),
  }) as AnthropicRunnableTool;
}

export function toAnthropicTools(tools: TownTool[]): AnthropicRunnableTool[] {
  return tools.map(toAnthropicTool);
}
