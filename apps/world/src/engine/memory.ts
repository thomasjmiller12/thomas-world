// Core-memory store backing the Anthropic memory tool (plan §4.2). Each agent
// owns a set of files under a virtual /memories root, persisted as rows in the
// memory_files table. Claude is post-trained on the view/create/str_replace/
// insert/delete/rename command semantics — we implement STORAGE only.
//
// Hard char caps keep core memory small enough to live below the cache
// breakpoint without blowing the budget (plan §4.3 "hard char caps").

import { and, eq } from "drizzle-orm";
import type { AgentId } from "@town/contract";
import { db, schema } from "../db/client.js";

const { memoryFiles } = schema;

// Per-file and per-agent total caps. Core memory is meant to be a handful of
// short files (identity, current focus, relationships) — not a journal.
export const MAX_FILE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 40_000;

export interface MemoryFile {
  path: string;
  content: string;
}

// Normalize a model-supplied path into our virtual namespace. Claude addresses
// files like "/memories/notes.md"; we store the path as-is but strip a leading
// slash duplication and reject traversal.
function normalizePath(raw: string): string {
  const p = raw.trim();
  if (p.includes("..")) throw new Error("path may not contain '..'");
  return p.startsWith("/") ? p : `/${p}`;
}

export async function listMemoryFiles(agentId: AgentId): Promise<MemoryFile[]> {
  const rows = await db
    .select()
    .from(memoryFiles)
    .where(eq(memoryFiles.agentId, agentId));
  return rows.map((r) => ({ path: r.path, content: r.content }));
}

async function readFile(agentId: AgentId, path: string): Promise<MemoryFile | undefined> {
  const [row] = await db
    .select()
    .from(memoryFiles)
    .where(and(eq(memoryFiles.agentId, agentId), eq(memoryFiles.path, path)));
  return row ? { path: row.path, content: row.content } : undefined;
}

async function totalChars(agentId: AgentId, excludePath?: string): Promise<number> {
  const files = await listMemoryFiles(agentId);
  return files
    .filter((f) => f.path !== excludePath)
    .reduce((n, f) => n + f.content.length, 0);
}

async function writeFile(agentId: AgentId, path: string, content: string): Promise<void> {
  if (content.length > MAX_FILE_CHARS) {
    throw new Error(`file exceeds ${MAX_FILE_CHARS} char cap`);
  }
  const existing = await totalChars(agentId, path);
  if (existing + content.length > MAX_TOTAL_CHARS) {
    throw new Error(`core memory would exceed ${MAX_TOTAL_CHARS} char cap`);
  }
  const existed = await readFile(agentId, path);
  if (existed) {
    await db
      .update(memoryFiles)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(memoryFiles.agentId, agentId), eq(memoryFiles.path, path)));
  } else {
    await db.insert(memoryFiles).values({ agentId, path, content });
  }
}

// --- the six memory-tool commands, implemented as storage ops ---------------

export async function memView(agentId: AgentId, path: string): Promise<string> {
  const p = normalizePath(path);
  // Directory view: if the path looks like a dir (ends in / or is /memories),
  // list files; otherwise return the file body with 1-based line numbers.
  if (p === "/memories" || p.endsWith("/")) {
    const files = await listMemoryFiles(agentId);
    const inDir = files.filter((f) => f.path.startsWith(p === "/memories" ? "/" : p));
    if (inDir.length === 0) return "(no memory files yet)";
    return inDir.map((f) => f.path).sort().join("\n");
  }
  const file = await readFile(agentId, p);
  if (!file) return `(no such file: ${p})`;
  return file.content
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}

export async function memCreate(agentId: AgentId, path: string, fileText: string): Promise<string> {
  const p = normalizePath(path);
  await writeFile(agentId, p, fileText);
  return `created ${p}`;
}

export async function memStrReplace(
  agentId: AgentId,
  path: string,
  oldStr: string,
  newStr: string,
): Promise<string> {
  const p = normalizePath(path);
  const file = await readFile(agentId, p);
  if (!file) throw new Error(`no such file: ${p}`);
  if (!file.content.includes(oldStr)) {
    throw new Error("old_str not found in file");
  }
  const updated = file.content.replace(oldStr, newStr);
  await writeFile(agentId, p, updated);
  return `edited ${p}`;
}

export async function memInsert(
  agentId: AgentId,
  path: string,
  insertLine: number,
  insertText: string,
): Promise<string> {
  const p = normalizePath(path);
  const file = await readFile(agentId, p);
  if (!file) throw new Error(`no such file: ${p}`);
  const lines = file.content.split("\n");
  const at = Math.max(0, Math.min(insertLine, lines.length));
  lines.splice(at, 0, insertText);
  await writeFile(agentId, p, lines.join("\n"));
  return `inserted at line ${at} of ${p}`;
}

export async function memDelete(agentId: AgentId, path: string): Promise<string> {
  const p = normalizePath(path);
  await db
    .delete(memoryFiles)
    .where(and(eq(memoryFiles.agentId, agentId), eq(memoryFiles.path, p)));
  return `deleted ${p}`;
}

export async function memRename(agentId: AgentId, oldPath: string, newPath: string): Promise<string> {
  const from = normalizePath(oldPath);
  const to = normalizePath(newPath);
  const file = await readFile(agentId, from);
  if (!file) throw new Error(`no such file: ${from}`);
  await writeFile(agentId, to, file.content);
  await db
    .delete(memoryFiles)
    .where(and(eq(memoryFiles.agentId, agentId), eq(memoryFiles.path, from)));
  return `renamed ${from} → ${to}`;
}

// A frozen snapshot of all core-memory files for the observation packet
// (plan §3.4 "core memory files (always loaded)"). Read once per tick and
// pinned below the cache breakpoint.
export async function coreMemorySnapshot(agentId: AgentId): Promise<string> {
  const files = await listMemoryFiles(agentId);
  if (files.length === 0) return "(your core memory is empty — you can write to it with the memory tool)";
  return files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `### ${f.path}\n${f.content}`)
    .join("\n\n");
}
