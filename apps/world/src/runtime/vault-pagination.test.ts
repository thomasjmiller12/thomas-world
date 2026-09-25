import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("../config.js", () => ({ config: { get vaultDir() { return state.root; } } }));
const { readNote } = await import("./vault.js");

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "town-vault-pages-"));
});
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
});

describe("vault note continuation", () => {
  it("reads the actual ending of a long source through hash-checked pages", async () => {
    const body = "a".repeat(16_000) + "FINAL MATRIX ROW\nComplete dataset end.";
    await mkdir(join(state.root, "Agents"));
    await writeFile(join(state.root, "Agents", "matrix.md"), body);
    const hash = createHash("sha256").update(body).digest("hex");
    const first = await readNote("Agents/matrix.md");
    expect(first.text).toContain('"offset":8000');
    expect(first.text).toContain(`"expected_sha":"${hash}"`);
    expect(first.text).not.toContain("FINAL MATRIX ROW");
    const second = await readNote("Agents/matrix.md", { offset: 8_000, expectedSha: hash });
    expect(second.text).toContain('"offset":16000');
    const final = await readNote("Agents/matrix.md", { offset: 16_000, expectedSha: hash });
    expect(final.text).toContain("FINAL MATRIX ROW\nComplete dataset end.");
    expect(final.text).toContain("End of content.");
  });

  it("rejects stale continuations after a synced file changes", async () => {
    await writeFile(join(state.root, "note.md"), "new contents");
    const result = await readNote("note.md", { offset: 8_000, expectedSha: "old-hash" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("changed since the previous page");
    expect(result.text).not.toContain("new contents");
  });

  it("keeps traversal and external-symlink reads outside the reference boundary", async () => {
    const outside = await mkdtemp(join(tmpdir(), "town-vault-outside-"));
    try {
      await writeFile(join(outside, "private.md"), "must not be read");
      await symlink(join(outside, "private.md"), join(state.root, "link.md"));
      expect((await readNote("link.md", { offset: 0 })).ok).toBe(false);
      expect((await readNote("../private.md", { offset: 0 })).ok).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("gives an actionable folder response instead of crashing a turn", async () => {
    await mkdir(join(state.root, "Agents"));
    expect((await readNote("Agents")).text).toContain("use list_notes");
  });
});
