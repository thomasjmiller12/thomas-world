// Shared Anthropic client + the cached system-prefix builder (plan §4.3).
//
// The system prefix is [soul base + facet soul + protocol]. Tool definitions
// render BEFORE the system block (SDK order: tools → system → messages), and
// the toolRunner serializes our deterministically-sorted tools — together they
// form the byte-stable cached prefix. We put a 1-hour cache_control breakpoint
// on the last system block so tools + system cache together (plan §4.3); the
// observation packet (current time + world state) lives in the user turn,
// below the breakpoint, so it never invalidates the cache.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentId } from "@town/contract";
import { config } from "../config.js";
import { baseSoul, getProfile } from "./roles.js";
import { PROTOCOL } from "./protocol.js";

// One process-wide client. The key may be undefined locally (env-gated): the
// tick runner checks config.anthropicApiKey before calling and skips otherwise.
export const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export function hasLlm(): boolean {
  return Boolean(config.anthropicApiKey);
}

// The cached system blocks for an agent. Stable across ticks (byte-identical):
// no timestamps, no live state. The cache_control breakpoint on the final block
// caches the whole [tools + system] prefix for 1 hour (refreshes on read, so
// any tick rate ≤ 60 min keeps it warm — plan §4.3).
export function systemBlocks(agentId: AgentId): Anthropic.Beta.BetaTextBlockParam[] {
  const profile = getProfile(agentId);
  const text = [baseSoul(), profile.soul, PROTOCOL].join("\n\n---\n\n");
  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

// Beta headers the runtime needs:
//  - context-management-2025-06-27: enables the memory tool (memory_20250818)
//  - extended-cache-ttl-2025-04-11: enables the 1-hour cache_control TTL
//  - mid-conversation-system-2026-04-07: appended only on Opus chats (plan §4.3
//    model gate) so operator context can be injected without breaking the cache.
export const TICK_BETAS = [
  "context-management-2025-06-27",
  "extended-cache-ttl-2025-04-11",
] as const;
export const MID_CONV_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
