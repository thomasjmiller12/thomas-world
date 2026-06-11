// Loads souls/base.md, souls/<agent>.md and roles/<agent>.yaml from disk once
// at boot. The soul text feeds the cached system prefix; the role yaml carries
// per-agent tick cadence/budget/model (plan §4.3 — budget tuning is config,
// not code).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentIds, type AgentId } from "@town/contract";

// src/runtime → ../../ is the apps/world package root (where souls/ + roles/ live).
const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, "..", "..");

export interface RoleConfig {
  tickCadenceMinutes: number;
  tickModel: string;
  chatModel: string;
  dailyTokenBudgetUsd: number;
}

export interface AgentProfile {
  id: AgentId;
  soul: string; // the agent's individual soul markdown (NOT base)
  role: RoleConfig;
}

function loadText(rel: string): string {
  return readFileSync(join(PKG_ROOT, rel), "utf8");
}

// Per-agent soul git hash (plan §4.1: attached to each trace as metadata so a
// soul edit is visible as a version dimension in Langfuse). We use the git blob
// hash of the agent's soul file — content-addressed, so it changes iff the soul
// text changes, independent of unrelated commits. Computed once and cached;
// falls back to "nogit" outside a checkout (env-gated runtime stays unaffected).
const soulHashCache = new Map<AgentId, string>();
export function soulGitHash(id: AgentId): string {
  const cached = soulHashCache.get(id);
  if (cached) return cached;
  let hash = "nogit";
  try {
    hash = execFileSync("git", ["hash-object", join("souls", `${id}.md`)], {
      cwd: PKG_ROOT,
      encoding: "utf8",
    })
      .trim()
      .slice(0, 12);
  } catch {
    /* not a git checkout (e.g. some prod images) — leave "nogit" */
  }
  soulHashCache.set(id, hash);
  return hash;
}

let baseSoulCache: string | null = null;
export function baseSoul(): string {
  if (baseSoulCache === null) baseSoulCache = loadText(join("souls", "base.md"));
  return baseSoulCache;
}

function loadRole(id: AgentId): RoleConfig {
  const raw = parseYaml(loadText(join("roles", `${id}.yaml`))) as Record<string, unknown>;
  return {
    tickCadenceMinutes: Number(raw.tick_cadence_minutes ?? 12),
    tickModel: String(raw.tick_model ?? "claude-haiku-4-5"),
    chatModel: String(raw.chat_model ?? "claude-opus-4-8"),
    dailyTokenBudgetUsd: Number(raw.daily_token_budget ?? 1.5),
  };
}

let profilesCache: Map<AgentId, AgentProfile> | null = null;

// Load every agent's soul + role once; cached for the process lifetime so the
// soul text stays byte-stable across ticks (cache hygiene, plan §4.3).
export function loadProfiles(): Map<AgentId, AgentProfile> {
  if (profilesCache) return profilesCache;
  const map = new Map<AgentId, AgentProfile>();
  for (const id of agentIds) {
    map.set(id, {
      id,
      soul: loadText(join("souls", `${id}.md`)),
      role: loadRole(id),
    });
  }
  profilesCache = map;
  return map;
}

export function getProfile(id: AgentId): AgentProfile {
  const p = loadProfiles().get(id);
  if (!p) throw new Error(`no profile for agent ${id}`);
  return p;
}
