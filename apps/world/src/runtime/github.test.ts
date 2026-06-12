import { describe, it, expect } from "vitest";
import {
  normalizeRepo,
  listRepos,
  browseRepo,
  readRepoFile,
  searchCode,
  GITHUB_REFERENCE_FICTION,
} from "./github.js";

describe("normalizeRepo", () => {
  it("prefixes a bare repo name with the default owner", () => {
    expect(normalizeRepo("thomas-world2")).toBe("thomasjmiller12/thomas-world2");
  });

  it("leaves an explicit owner/repo untouched (collaborator repos)", () => {
    expect(normalizeRepo("someorg/backend")).toBe("someorg/backend");
  });

  it("trims stray slashes and whitespace", () => {
    expect(normalizeRepo("  /thomas-world2/ ")).toBe("thomasjmiller12/thomas-world2");
  });
});

// In CI / local test runs GITHUB_TOKEN is absent, so every tool must degrade
// in-fiction rather than throw or hit the network (the env-gating contract).
describe("env-gated degradation (no GITHUB_TOKEN)", () => {
  it("list_repos returns the in-fiction soft failure", async () => {
    const r = await listRepos();
    expect(r.ok).toBe(false);
    expect(r.text).toBe(GITHUB_REFERENCE_FICTION);
  });

  it("browse_repo / read_repo_file / search_code all degrade in-fiction", async () => {
    for (const r of [
      await browseRepo("thomas-world2", "."),
      await readRepoFile("thomas-world2", "README.md"),
      await searchCode("toolRunner"),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.text).toBe(GITHUB_REFERENCE_FICTION);
    }
  });
});
