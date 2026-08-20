import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../config.js";

export const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export function anthropicSystemBlocks(
  systemPrompt: string,
): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    {
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

export const TICK_BETAS = [
  "context-management-2025-06-27",
  "extended-cache-ttl-2025-04-11",
] as const;

export const MID_CONV_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
