import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { githubToken: "test-only-token", githubUser: "thomasjmiller12" },
}));
const { readRepoFile } = await import("./github.js");

afterEach(() => vi.unstubAllGlobals());

function githubFile(body: string, sha = "same-blob") {
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    encoding: "base64", content: Buffer.from(body).toString("base64"), sha,
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("repository file continuation", () => {
  it("retrieves data beyond both old truncation limits without clipping the continuation", async () => {
    const body = "a".repeat(16_000) + "THE PREVIOUSLY INACCESSIBLE MATRIX ROW\n" + "z".repeat(5_000);
    const fetch = githubFile(body);
    const first = await readRepoFile("codenames", "matrix.csv", "main");
    expect(first.text).toContain('"offset":8000');
    expect(first.text).toContain('"expected_sha":"same-blob"');
    expect(first.text).not.toContain("INACCESSIBLE");
    const middle = await readRepoFile("codenames", "matrix.csv", "main", { offset: 8_000, expectedSha: "same-blob" });
    expect(middle.text).toContain('"offset":16000');
    const last = await readRepoFile("codenames", "matrix.csv", "main", { offset: 16_000, expectedSha: "same-blob" });
    expect(last.text).toContain("THE PREVIOUSLY INACCESSIBLE MATRIX ROW");
    expect(last.text).toContain("End of content.");
    expect(fetch.mock.calls).toHaveLength(3);
  });

  it("refuses to join pages from different file revisions", async () => {
    githubFile("new content", "changed-blob");
    const result = await readRepoFile("codenames", "matrix.csv", undefined, { offset: 8_000, expectedSha: "old-blob" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("changed since the previous page");
    expect(result.text).not.toContain("new content");
  });

  it("bounds page size and reports out-of-range offsets", async () => {
    githubFile("only a short file");
    const outOfRange = await readRepoFile("codenames", "matrix.csv", undefined, { offset: 100 });
    expect(outOfRange.text).toContain("past the end");
    const tooLarge = await readRepoFile("codenames", "matrix.csv", undefined, { maxChars: 50_000 });
    expect(tooLarge.text).toContain("between 1 and 12000");
    expect(tooLarge.text).not.toContain("only a short file");
  });
});
