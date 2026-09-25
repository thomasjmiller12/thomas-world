import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  readFile: vi.fn(), readdir: vi.fn(), realpath: vi.fn(), stat: vi.fn(),
}));
vi.mock("../config.js", () => ({ config: { vaultDir: "/test-vault" } }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:fs/promises", () => ({ ...fs, mkdir: vi.fn(), writeFile: vi.fn() }));
const { listNotes, readNote, searchNotes } = await import("./vault.js");
const entry = (name: string, directory: boolean) => ({ name, isDirectory: () => directory });

beforeEach(() => {
  vi.clearAllMocks();
  fs.realpath.mockImplementation(async (path: string) => path);
  fs.stat.mockResolvedValue({ isFile: () => true });
  fs.readFile.mockResolvedValue("searchable allowed note");
});

describe("protected vault folders", () => {
  it("refuses a protected path before filesystem access", async () => {
    expect((await readNote("_Scratch/private.md")).ok).toBe(false);
    expect((await listNotes("Areas/_Scratch")).ok).toBe(false);
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it("does not follow a symlink alias into a protected folder", async () => {
    fs.realpath.mockImplementation(async (path: string) => path.endsWith("alias.md") ? "/test-vault/_Scratch/private.md" : path);
    expect((await readNote("alias.md")).ok).toBe(false);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("omits protected names from listings and never walks them during search", async () => {
    fs.readdir.mockResolvedValue([entry("_Scratch", true), entry("allowed.md", false)]);
    expect((await listNotes(".")).text).toBe("allowed.md");
    const result = await searchNotes("searchable");
    expect(result.text).toBe("allowed.md");
    expect(fs.readdir.mock.calls.every(([path]) => path === "/test-vault")).toBe(true);
    expect(fs.readFile).toHaveBeenCalledExactlyOnceWith("/test-vault/allowed.md", "utf8");
  });

  it("checks search-result symlinks before reading their target", async () => {
    fs.readdir.mockResolvedValue([entry("alias.md", false)]);
    fs.realpath.mockImplementation(async (path: string) => path.endsWith("alias.md") ? "/test-vault/_Scratch/private.md" : path);
    expect((await searchNotes("searchable")).text).toContain("No notes mention");
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
