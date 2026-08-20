import type { AgentId } from "@town/contract";
import { baseSoul, getProfile } from "../roles.js";
import { PROTOCOL } from "../protocol.js";

// Stable across turns: no timestamps or live state. Provider adapters decide
// how to cache or encode this shared identity/protocol prefix.
export function buildSystemPrompt(agentId: AgentId): string {
  const profile = getProfile(agentId);
  return [baseSoul(), profile.soul, PROTOCOL].join("\n\n---\n\n");
}
