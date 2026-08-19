// Compatibility facade while the remaining stateless Anthropic call sites move
// to the provider interface (Task 9). Stateful turns no longer import this file.
//
// The system prefix is [soul base + facet soul + protocol]. Tool definitions
// render BEFORE the system block (SDK order: tools → system → messages), and
// the toolRunner serializes our deterministically-sorted tools — together they
// form the byte-stable cached prefix. We put a 1-hour cache_control breakpoint
// on the last system block so tools + system cache together (plan §4.3); the
// observation packet (current time + world state) lives in the user turn,
// below the breakpoint, so it never invalidates the cache.

import type { AgentId } from "@town/contract";
import {
  anthropic,
  anthropicSystemBlocks,
  MID_CONV_SYSTEM_BETA,
  TICK_BETAS,
} from "./llm/anthropic/client.js";
import { buildSystemPrompt } from "./llm/system.js";

export { anthropic, MID_CONV_SYSTEM_BETA, TICK_BETAS };
export { hasLlm } from "./llm/provider.js";

// The cached system blocks for an agent. Stable across ticks (byte-identical):
// no timestamps, no live state. The cache_control breakpoint on the final block
// caches the whole [tools + system] prefix for 1 hour (refreshes on read, so
// any tick rate ≤ 60 min keeps it warm — plan §4.3).
export function systemBlocks(agentId: AgentId) {
  return anthropicSystemBlocks(buildSystemPrompt(agentId));
}
