import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configuration = vi.hoisted(() => ({
  hindsightUrl: "http://hindsight.internal:8888",
  features: { hindsight: true },
}));
vi.mock("../config.js", () => ({ config: configuration }));

import { HINDSIGHT_TIMEOUT_MS, memoryBankStats, recall, reflect, remember } from "./hindsight.js";

const fetchMock = vi.fn<typeof fetch>();
const stored = { success: true, bank_id: "town-builder", items_count: 1, async: false };

beforeEach(() => {
  configuration.features.hindsight = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hindsight 0.7 client contract", () => {
  it("retains source identity and event time so repeating a digest replaces the same document", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(stored));
    expect(await remember("builder", "Public evidence", "town_public", {
      documentId: "town-builder-2026-09-25", observedAt: "2026-09-25T18:00:00Z",
      metadata: { event_ids: "10,11", agent: "spoofed" },
    })).toEqual({ ok: true, text: "Stored." });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://hindsight.internal:8888/v1/default/banks/town-builder/memories");
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ content: "Public evidence", tags: ["town_public"],
        metadata: { event_ids: "10,11", agent: "builder", kind: "town_public" },
        document_id: "town-builder-2026-09-25", timestamp: "2026-09-25T18:00:00Z" }],
      async: false,
    });
  });

  it("keeps existing calls compatible without inventing source metadata", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(stored));
    await remember("builder", "An observation", "observation");
    const item = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).items[0];
    expect(item).not.toHaveProperty("document_id");
    expect(item).not.toHaveProperty("timestamp");
  });

  it.each([
    [{ ...stored, async: true }, "rejected"],
    [{ ...stored, success: false }, "rejected"],
    [{ ...stored, bank_id: "town-writer" }, "rejected"],
    [{ ...stored, items_count: 0 }, "rejected"],
    [{ message: "accepted" }, "invalid_response"],
  ])("does not report an unconfirmed retain as stored: %j", async (body, reason) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    expect(await remember("builder", "Evidence", "observation")).toMatchObject({ ok: false, reason });
  });

  it("distinguishes the actual database HTTP 500 from empty recall and never logs body content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    fetchMock.mockResolvedValue(Response.json({ detail: "operator does not exist: text % text", private_text: "visitor secret" }, { status: 500 }));
    const first = await remember("builder", "Private content", "visit");
    expect(first).toMatchObject({ ok: false, reason: "http", status: 500 });
    await remember("builder", "Private content", "visit");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/visitor secret|Private content|operator does not exist/);
    fetchMock.mockResolvedValueOnce(Response.json({ total_nodes: 0, total_documents: 0, pending_operations: 0, failed_operations: 0 }));
    expect(await memoryBankStats("builder")).toMatchObject({ ok: true,
      stats: { total_nodes: 0 }, lastFailure: { operation: "remember", reason: "http", status: 500 } });
  });

  it("bounds a stuck request without retrying a potentially completed write", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = remember("builder", "Evidence", "observation");
    await vi.advanceTimersByTimeAsync(HINDSIGHT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url, init) => ({ ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    }) as Response);
    const pending = recall("builder", "Old work");
    await vi.advanceTimersByTimeAsync(HINDSIGHT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("does not silently convert a malformed recall response into no memories", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ unexpected: [] }));
    expect(await recall("builder", "Old work")).toMatchObject({ ok: false, reason: "invalid_response" });
    fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
    expect(await recall("builder", "Old work")).toEqual({ ok: true, text: "(nothing relevant came to mind)" });
  });

  it("strictly scopes public recall and never falls back on an empty result", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
    await recall("builder", "Public project progress", 400, { tags: ["town_public"] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      query: "Public project progress", max_tokens: 400, tags: ["town_public"], tags_match: "all_strict",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await recall("builder", "Public project progress", 400, { tags: [] })).toMatchObject({ ok: false, reason: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns successful recall text and the actual reflection answer", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ text: "First fact" }, { text: "Second fact" }] }));
    expect(await recall("builder", "Facts")).toEqual({ ok: true, text: "First fact\n---\nSecond fact" });
    fetchMock.mockResolvedValueOnce(Response.json({ text: "A synthesis" }));
    expect(await reflect("builder")).toEqual({ ok: true, text: "A synthesis" });
  });

  it("handles disabled integration and network errors without leaking exception text", async () => {
    configuration.features.hindsight = false;
    expect(await remember("builder", "Evidence", "observation")).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    configuration.features.hindsight = true;
    fetchMock.mockRejectedValueOnce(new Error("private credentials in error"));
    expect(await recall("builder", "Facts")).toMatchObject({ ok: false, reason: "network" });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private credentials");
  });
});
