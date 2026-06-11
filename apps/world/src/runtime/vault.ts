// Obsidian vault reference layer (plan §7, plan §4.2 reference tools). The
// server holds a read-only clone of the private vault repo; agents get
// list/read/search over it and one writable Agents/<id>/ folder that syncs back.
//
// Fully env-gated (brief): no VAULT_DIR => reference tools degrade in-fiction
// ("the library shipment hasn't arrived yet"); write_agent_note still writes to
// a local vault-pending/ dir so nothing the agent makes is lost.

import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "@town/contract";
import { config } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(here, "..", "..");
// Local fallback for agent writes when no real vault dir is configured.
const PENDING_DIR = join(PKG_ROOT, "vault-pending");

export const VAULT_REFERENCE_FICTION =
  "The library shipment hasn't arrived yet — the shelves are still bare. You can jot things in your own Agents folder, but there's nothing to read here yet.";

export interface ReferenceResult {
  ok: boolean;
  text: string;
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "[vault] VAULT_DIR absent — reference tools degrade in-fiction; agent notes write to vault-pending/.",
  );
}

function vaultRoot(): string | null {
  return config.vaultDir ?? null;
}

// Guard against path traversal: resolved path must stay within `base`.
function safeJoin(base: string, rel: string): string | null {
  const target = resolve(base, rel.replace(/^\/+/, ""));
  const baseResolved = resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) return null;
  return target;
}

// --- read-side tools --------------------------------------------------------

export async function listNotes(dir: string): Promise<ReferenceResult> {
  const root = vaultRoot();
  if (!root) {
    warnOnce();
    return { ok: false, text: VAULT_REFERENCE_FICTION };
  }
  const target = safeJoin(root, dir || ".");
  if (!target || !existsSync(target)) return { ok: false, text: `Nothing at ${dir}.` };
  const entries = await readdir(target, { withFileTypes: true });
  const lines = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return { ok: true, text: lines.length ? lines.join("\n") : "(empty)" };
}

export async function readNote(path: string): Promise<ReferenceResult> {
  const root = vaultRoot();
  if (!root) {
    warnOnce();
    return { ok: false, text: VAULT_REFERENCE_FICTION };
  }
  const target = safeJoin(root, path);
  if (!target || !existsSync(target)) return { ok: false, text: `No note at ${path}.` };
  const body = await readFile(target, "utf8");
  // Cap how much a single read can pull into the tick context.
  return { ok: true, text: body.length > 12_000 ? body.slice(0, 12_000) + "\n…(truncated)" : body };
}

// Simple recursive substring search over .md files (no RAG at MVP, plan §8).
export async function searchNotes(query: string): Promise<ReferenceResult> {
  const root = vaultRoot();
  if (!root) {
    warnOnce();
    return { ok: false, text: VAULT_REFERENCE_FICTION };
  }
  const q = query.toLowerCase();
  const rootDir: string = root; // narrowed; bind so the nested closure keeps it non-null
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= 20) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.endsWith(".md")) {
        try {
          const body = await readFile(full, "utf8");
          if (body.toLowerCase().includes(q)) {
            hits.push(relative(rootDir, full));
          }
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  };
  await walk(rootDir);
  return {
    ok: true,
    text: hits.length ? hits.slice(0, 20).join("\n") : `No notes mention "${query}".`,
  };
}

// --- write-side tool (Agents/<id>/ only) ------------------------------------

export async function writeAgentNote(
  agentId: AgentId,
  relPath: string,
  content: string,
): Promise<ReferenceResult> {
  // Restrict writes to the agent's own folder regardless of what they pass.
  const cleaned = relPath.replace(/^\/+/, "").replace(/\.\.+/g, "");
  const rel = join("Agents", agentId, cleaned);
  const root = vaultRoot();
  const base = root ?? PENDING_DIR;
  if (!root) warnOnce();
  const target = safeJoin(base, rel);
  if (!target) return { ok: false, text: "That path isn't allowed." };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return {
    ok: true,
    text: root
      ? `Saved to ${rel} (will sync back to the vault).`
      : `Saved locally to ${rel} (no vault connected yet — it'll sync when the library opens).`,
  };
}

// --- git sync (clone / pull / write-back commit) ----------------------------

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    const key = process.env.VAULT_DEPLOY_KEY_PATH;
    if (key) {
      // Use the read-only deploy key for fetch/pull (narrowest credential).
      env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
    const p = spawn("git", args, { cwd, env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
    p.on("error", (err) => resolve({ code: 1, out: String(err) }));
  });
}

// Clone the vault repo if not present, else pull. No-op when the repo URL or
// vault dir is absent (the feature is off; reference tools already degrade).
export async function syncVault(): Promise<void> {
  const root = vaultRoot();
  const repoUrl = process.env.VAULT_REPO_URL;
  if (!root || !repoUrl) return;
  try {
    if (!existsSync(join(root, ".git"))) {
      await mkdir(root, { recursive: true });
      const res = await git(["clone", repoUrl, "."], root);
      if (res.code !== 0) console.warn("[vault] clone failed:", res.out.slice(0, 300));
    } else {
      const res = await git(["pull", "--ff-only"], root);
      if (res.code !== 0) console.warn("[vault] pull failed:", res.out.slice(0, 300));
    }
  } catch (err) {
    console.warn("[vault] sync error:", (err as Error).message);
  }
}

// Commit + push agent-authored notes under Agents/ back to the vault repo.
// Disjoint write paths (Agents/ only) mean no merge conflicts (plan §7).
export async function pushAgentNotes(): Promise<void> {
  const root = vaultRoot();
  const repoUrl = process.env.VAULT_REPO_URL;
  if (!root || !repoUrl || !existsSync(join(root, ".git"))) return;
  try {
    const agentsDir = join(root, "Agents");
    if (!existsSync(agentsDir)) return;
    const dirty = await git(["status", "--porcelain", "Agents/"], root);
    if (!dirty.out.trim()) return;
    await git(["add", "Agents/"], root);
    await git(["commit", "-m", "Agent notes (world server)"], root);
    const res = await git(["push"], root);
    if (res.code !== 0) console.warn("[vault] push failed:", res.out.slice(0, 300));
  } catch (err) {
    console.warn("[vault] push error:", (err as Error).message);
  }
}

// Touch unused imports so tsc with noUnusedLocals (if enabled later) is happy;
// `stat` reserved for a future size check.
void stat;
